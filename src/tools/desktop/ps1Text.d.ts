/** The Windows desktop driver script is bundled as text (esbuild `loader: { '.ps1': 'text' }`, vitest transform). */
declare module '*.ps1' {
  const text: string;
  export default text;
}
