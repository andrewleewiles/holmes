declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*?raw' {
  const src: string
  export default src
}

/** Vite inlines these as data: URLs — see AnimatedMark for why that's required. */
declare module '*?inline' {
  const src: string
  export default src
}
