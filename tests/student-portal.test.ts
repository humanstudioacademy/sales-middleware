import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnrollmentRequest,
  buildMatriculaPayload,
  buildRevogacaoPayload,
  desiredEnrollmentAction,
  resolveEnrollmentOffer,
  revocationReason,
  type StudentPortalOffer,
} from "../supabase/functions/_shared/student-portal.ts";
import { type CommerceOrder, parseZoutiOrder } from "../supabase/functions/_shared/zouti-order.ts";

const agentLabPayload = {
  id: "ord_agentlab_1",
  provider: "ZOUTI",
  status: "PAID",
  currency: "BRL",
  created_at: "2026-08-10T10:00:00.000Z",
  updated_at: "2026-08-10T10:00:00.000Z",
  amount_total: 199700,
  amount_total_in_brl: 1997,
  customer_id: "cus_agentlab_1",
  customer: {
    name: "Aluna Exemplo",
    document: "123.456.789-01",
    email: "Aluna@Example.Test",
    phone: "+55 11 98888-7777",
  },
  items: [{
    product_id: "prod_agentlab_agl3",
    name: "AgentLab",
    description: "Turma 3",
    type: "SKU",
    quantity: 1,
    amount: 199700,
    amount_in_brl: 1997,
  }],
  payment: { method: "PIX", installments: 1, amount: 199700, amount_in_brl: 1997 },
};

const offers: StudentPortalOffer[] = [{
  source_platform: "zouti",
  source_product_id: "prod_agentlab_agl3",
  edition_code: "agent-lab-3",
  product_label: "AgentLab 3",
  enabled: true,
  starts_at: "2026-08-04T03:00:00.000Z",
  ends_at: "2026-09-20T03:00:00.000Z",
  grants_replay: false,
}];

/** Mesmo produto, janela seguinte: a turma vira sem trocar a oferta na Zouti. */
const nextEdition: StudentPortalOffer = {
  ...offers[0],
  edition_code: "agent-lab-4",
  product_label: "AgentLab 4",
  starts_at: "2026-09-20T03:00:00.000Z",
  ends_at: null,
};

const trace = {
  webhookId: "00000000-0000-4000-8000-000000000001",
  ingestSequence: 42,
  bodySha256: "a".repeat(64),
};

function orderWith(overrides: Record<string, unknown> = {}): CommerceOrder {
  return parseZoutiOrder({ ...agentLabPayload, ...overrides }, "zouti");
}

test("elege a venda pelo produto mapeado e resolve a edição", () => {
  const resolved = resolveEnrollmentOffer(orderWith(), offers);
  assert.equal(resolved?.editionCode, "agent-lab-3");
  assert.equal(resolved?.item.sourceId, "prod_agentlab_agl3");
});

test("ignora vendas de outros produtos e ofertas desativadas", () => {
  const otherProduct = orderWith({
    items: [{ ...agentLabPayload.items[0], product_id: "prod_outro", name: "Outro curso" }],
  });
  assert.equal(resolveEnrollmentOffer(otherProduct, offers), null);

  const disabled = offers.map((offer) => ({ ...offer, enabled: false }));
  assert.equal(resolveEnrollmentOffer(orderWith(), disabled), null);
});

test("não escolhe edição no escuro quando o cadastro conflita", () => {
  const twoEditions: StudentPortalOffer[] = [
    ...offers,
    { ...offers[0], source_product_id: "prod_agentlab_agl4", edition_code: "agent-lab-4" },
  ];
  const order = orderWith({
    items: [
      agentLabPayload.items[0],
      { ...agentLabPayload.items[0], product_id: "prod_agentlab_agl4", name: "AgentLab 4" },
    ],
  });
  assert.throws(() => resolveEnrollmentOffer(order, twoEditions), /mapping conflict/);
});

test("a edição vem da janela em que a compra caiu, não da que está vendendo hoje", () => {
  const janela = [offers[0], nextEdition];

  const dentro = resolveEnrollmentOffer(orderWith(), janela);
  assert.equal(dentro?.editionCode, "agent-lab-3");

  const depois = resolveEnrollmentOffer(
    orderWith({ created_at: "2026-10-01T10:00:00.000Z", updated_at: "2026-10-01T10:00:00.000Z" }),
    janela,
  );
  assert.equal(depois?.editionCode, "agent-lab-4");

  // Venda anterior à primeira janela não pertence a nenhuma turma.
  const antes = resolveEnrollmentOffer(
    orderWith({ created_at: "2026-08-03T10:00:00.000Z", updated_at: "2026-08-03T10:00:00.000Z" }),
    janela,
  );
  assert.equal(antes, null);
});

test("os limites da janela são inclusivo no início e exclusivo no fim", () => {
  const noPrimeiroInstante = orderWith({
    created_at: offers[0].starts_at,
    updated_at: offers[0].starts_at,
  });
  assert.equal(resolveEnrollmentOffer(noPrimeiroInstante, offers)?.editionCode, "agent-lab-3");

  const noInstanteDoCorte = orderWith({
    created_at: offers[0].ends_at!,
    updated_at: offers[0].ends_at!,
  });
  assert.equal(resolveEnrollmentOffer(noInstanteDoCorte, offers), null);
});

test("um reembolso tardio revoga a edição original, não a turma do momento", () => {
  const janela = [offers[0], nextEdition];
  // Comprou na 3ª edição em agosto, pediu reembolso em outubro, quando a 4ª
  // edição já está vendendo pelo mesmo produto.
  const reembolsoTardio = orderWith({
    status: "REFUNDED",
    created_at: "2026-08-10T10:00:00.000Z",
    updated_at: "2026-10-05T10:00:00.000Z",
  });
  const resolved = resolveEnrollmentOffer(reembolsoTardio, janela);
  assert.equal(resolved?.editionCode, "agent-lab-3");
  assert.equal(buildRevogacaoPayload(reembolsoTardio, resolved!.editionCode).edicao, "agent-lab-3");
});

test("libera no pagamento e só revoga depois de ter liberado", () => {
  assert.equal(desiredEnrollmentAction("paid", "pending"), "grant");
  assert.equal(desiredEnrollmentAction("refunded", "granted"), "revoke");
  assert.equal(desiredEnrollmentAction("chargeback", "granted"), "revoke");
  assert.equal(desiredEnrollmentAction("cancelled", "granted"), "revoke");
  assert.equal(desiredEnrollmentAction("refunded", "pending"), "record_only");
  assert.equal(desiredEnrollmentAction("pending", "pending"), "record_only");
  assert.equal(desiredEnrollmentAction("rejected", "granted"), "record_only");
});

test("monta exatamente o corpo aceito por /functions/v1/matricula", () => {
  const order = orderWith();
  const resolved = resolveEnrollmentOffer(order, offers)!;
  const payload = buildMatriculaPayload(order, resolved.editionCode);

  assert.deepEqual(payload, {
    email: "aluna@example.test",
    edicao: "agent-lab-3",
    nome: "Aluna Exemplo",
    temReplay: false,
    origem: "zouti",
  });
  assert.deepEqual(Object.keys(payload), ["email", "edicao", "nome", "temReplay", "origem"]);
});

test("para a matrícula quando a ordem não tem e-mail", () => {
  const order = orderWith({
    customer: { ...agentLabPayload.customer, email: "   " },
  });
  assert.throws(
    () => buildMatriculaPayload(order, "agent-lab-3"),
    /mapping is incomplete.*no customer e-mail/,
  );
});

test("monta exatamente o corpo de revogação, sem nome nem origem", () => {
  const order = orderWith({ status: "REFUNDED", updated_at: "2026-08-10T12:00:00.000Z" });
  const resolved = resolveEnrollmentOffer(order, offers)!;
  const payload = buildRevogacaoPayload(order, resolved.editionCode);

  assert.deepEqual(payload, {
    acao: "revogar",
    email: "aluna@example.test",
    edicao: "agent-lab-3",
    motivo: "reembolso",
  });
  assert.deepEqual(Object.keys(payload), ["acao", "email", "edicao", "motivo"]);
});

test("traduz o motivo a partir do status da ordem", () => {
  assert.equal(revocationReason("refunded"), "reembolso");
  assert.equal(revocationReason("chargeback"), "chargeback");
  assert.equal(revocationReason("cancelled"), "cancelamento");
});

test("o mesmo endpoint recebe cadastro e revogação com corpos diferentes", () => {
  const paid = orderWith();
  const resolved = resolveEnrollmentOffer(paid, offers)!;
  const shared = {
    editionCode: resolved.editionCode,
    item: resolved.item,
    destinationUrl: "https://plaqjikpfueqmftjrhvs.supabase.co/functions/v1/matricula",
    token: "token-do-portal",
    trace,
  };

  const grant = buildEnrollmentRequest({ ...shared, action: "grant", order: paid });
  const revoke = buildEnrollmentRequest({
    ...shared,
    action: "revoke",
    order: orderWith({ status: "DISPUTED", updated_at: "2026-08-10T12:00:00.000Z" }),
  });

  assert.equal(grant.url, revoke.url);
  assert.equal(grant.headers.get("x-matricula-token"), revoke.headers.get("x-matricula-token"));
  assert.equal(JSON.parse(grant.body).acao, undefined);
  assert.deepEqual(JSON.parse(revoke.body), {
    acao: "revogar",
    email: "aluna@example.test",
    edicao: "agent-lab-3",
    motivo: "chargeback",
  });
});

test("autentica pelo header do portal e mantém o rastro da entrega", () => {
  const order = orderWith();
  const resolved = resolveEnrollmentOffer(order, offers)!;
  const request = buildEnrollmentRequest({
    action: "grant",
    editionCode: resolved.editionCode,
    order,
    item: resolved.item,
    destinationUrl: "https://plaqjikpfueqmftjrhvs.supabase.co/functions/v1/matricula",
    token: "token-do-portal",
    trace,
  });

  assert.equal(request.url, "https://plaqjikpfueqmftjrhvs.supabase.co/functions/v1/matricula");
  assert.equal(request.headers.get("x-matricula-token"), "token-do-portal");
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal(request.headers.get("idempotency-key"), `student-portal-${trace.webhookId}`);
  assert.equal(request.headers.get("x-humanos-order-id"), "ord_agentlab_1");
  assert.equal(request.headers.get("x-humanos-ingest-sequence"), "42");
  assert.deepEqual(JSON.parse(request.body), {
    email: "aluna@example.test",
    edicao: "agent-lab-3",
    nome: "Aluna Exemplo",
    temReplay: false,
    origem: "zouti",
  });
});

/**
 * O formato de aulas é outro produto dentro da mesma edição. Antes disso o
 * middleware nunca mandava `temReplay`, então quem comprava o gravado entrava
 * na turma com o replay trancado.
 */
const replayOffer: StudentPortalOffer = {
  ...offers[0],
  source_product_id: "prod_agentlab_agl3_aulas",
  product_label: "AgentLab 3 em formato de aulas",
  grants_replay: true,
};

const itemDeAulas = {
  ...agentLabPayload.items[0],
  product_id: "prod_agentlab_agl3_aulas",
  name: "AgentLab em formato de aulas",
};

test("só o ingresso não libera o replay", () => {
  const resolved = resolveEnrollmentOffer(orderWith(), [offers[0], replayOffer])!;
  assert.equal(resolved.grantsReplay, false);
  assert.equal(buildMatriculaPayload(orderWith(), resolved.editionCode, resolved.grantsReplay).temReplay, false);
});

test("o formato de aulas libera o replay na mesma edição", () => {
  const order = orderWith({ items: [itemDeAulas] });
  const resolved = resolveEnrollmentOffer(order, [offers[0], replayOffer])!;
  assert.equal(resolved.editionCode, "agent-lab-3");
  assert.equal(resolved.grantsReplay, true);
  assert.equal(buildMatriculaPayload(order, resolved.editionCode, resolved.grantsReplay).temReplay, true);
});

test("ingresso e aulas na mesma ordem liberam o replay, em qualquer ordem dos itens", () => {
  const catalogo = [offers[0], replayOffer];
  for (const items of [[agentLabPayload.items[0], itemDeAulas], [itemDeAulas, agentLabPayload.items[0]]]) {
    const resolved = resolveEnrollmentOffer(orderWith({ items }), catalogo)!;
    assert.equal(resolved.editionCode, "agent-lab-3");
    assert.equal(resolved.grantsReplay, true);
  }
});

test("a revogação continua sem temReplay: o corpo é outro contrato", () => {
  const order = orderWith({ status: "REFUNDED", updated_at: "2026-08-10T12:00:00.000Z" });
  const request = buildEnrollmentRequest({
    action: "revoke",
    editionCode: "agent-lab-3",
    grantsReplay: true,
    order,
    item: order.items[0],
    destinationUrl: "https://portal.example.test/functions/v1/matricula",
    token: "token-de-teste",
    trace,
  });
  assert.equal(JSON.parse(request.body).temReplay, undefined);
});
