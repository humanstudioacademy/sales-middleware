import { classifyHotmartEvent, HOTMART_PLATFORM, parseHotmartOrder } from "./hotmart-order.ts";
import {
  classifyInboundCommerceEvent,
  type CommerceOrder,
  type InboundCommerceEvent,
  normalizePlatform,
  parseZoutiOrder,
} from "./zouti-order.ts";

/**
 * Ponto único de entrada dos adaptadores de plataforma. Cada plataforma tem o
 * seu contrato de JSON, mas todas produzem o mesmo `CommerceOrder`, e é esse
 * modelo — não o webhook — que decide o que acontece na Conta Azul. A
 * identidade `(plataforma, id externo)` é a mesma regra para todas.
 */
export function classifyCommerceEvent(body: unknown, sourcePlatform: string): InboundCommerceEvent {
  const platform = normalizePlatform(sourcePlatform);
  if (platform === HOTMART_PLATFORM) return classifyHotmartEvent(body);
  return classifyInboundCommerceEvent(body, sourcePlatform);
}

export function parseCommerceOrder(body: unknown, sourcePlatform: string): CommerceOrder {
  const platform = normalizePlatform(sourcePlatform);
  if (platform === HOTMART_PLATFORM) return parseHotmartOrder(body);
  if (platform === "zouti") return parseZoutiOrder(body, sourcePlatform);
  throw new Error(`Commerce platform adapter not implemented: ${platform}`);
}
