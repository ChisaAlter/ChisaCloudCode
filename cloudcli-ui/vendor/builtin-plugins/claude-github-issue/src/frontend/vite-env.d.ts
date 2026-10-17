/// <reference types="vite/client" />

// Allow importing CSS files as raw strings with ?inline query
declare module '*.css?inline' {
  const content: string;
  export default content;
}
