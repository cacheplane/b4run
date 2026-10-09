/**
 * The app's name, "B4.run / navlog", as plain ink type. It replaces the old
 * gradient brand mark: LiveLoveApp's rules allow no gradients and no text
 * with a gradient fill. Styles: `.wb-wordmark` in `app/theme.css`.
 */
export function Wordmark() {
  return (
    <span className="wb-wordmark">
      B4.run <span className="wb-wordmark-product">/ navlog</span>
    </span>
  )
}
