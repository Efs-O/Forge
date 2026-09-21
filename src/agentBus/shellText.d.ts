/** Shell scripts are bundled as text (esbuild `loader: { '.sh': 'text' }`, vitest transform). */
declare module '*.sh' {
  const text: string;
  export default text;
}
