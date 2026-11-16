/** Script and Markdown assets are bundled as text (esbuild text loaders, vitest transform). */
declare module '*.sh' {
  const text: string;
  export default text;
}

declare module '*.md' {
  const text: string;
  export default text;
}
