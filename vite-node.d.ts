// The one Node binding the build plugins need, declared rather than depended on.
//
// tsconfig sets "types": [] and this project has no @types/node, which is deliberate: vite.config.ts computes its CSP hash with WebCrypto rather than node:crypto for exactly this reason. vite-data-boot.ts has to read one generated file off disk so it can emit it as a hashed asset, and pulling the whole Node type surface into a build that is being trimmed of unused dependencies would be an odd trade for one function call.
//
// Only the call that is actually made, and only the overload that is actually used. A wider declaration would be a promise this file has no way to keep, and the next person to reach for something under it would get a type error rather than a missing module and would not know which of the two problems they had.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
