export function contaAzulReadPath(input: URL): string {
  const resource = input.searchParams.get("resource") ?? "sales";
  const forwarded = new URLSearchParams(input.searchParams);
  forwarded.delete("resource");

  const paths: Record<string, string> = {
    sales: "/v1/venda/busca",
    financial_accounts: "/v1/conta-financeira",
    categories: "/v1/categorias",
    people: "/v1/pessoas",
    products: "/v1/produtos",
    next_sale_number: "/v1/venda/proximo-numero",
  };
  const path = paths[resource];
  if (!path) throw new Error("Unsupported Conta Azul read resource");
  const query = forwarded.toString();
  return query ? `${path}?${query}` : path;
}
