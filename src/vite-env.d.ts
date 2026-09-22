// The two data files are imported for their URL, not their contents, so the
// browser fetches and JSON.parses them instead of the bundler compiling them
// into the script as object literals. Declared here rather than by pulling in
// vite/client, which would bring the whole ambient environment with it.
declare module "*?url" {
  const url: string;
  export default url;
}
