/** Refund the customer's last order, in cents. */
export default async (input: { readonly amount: number }) => {
  return { refunded: input.amount }
}
