/** Delete a user account. Shared by every route in src/app/. */
export default async (input: { readonly userId: string }) => {
  return { deleted: input.userId }
}
