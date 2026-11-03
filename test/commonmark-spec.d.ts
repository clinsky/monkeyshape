/** The CommonMark project's spec examples, a dev dependency read only by tests. */
declare module "commonmark-spec" {
  export const tests: ReadonlyArray<{
    readonly markdown: string;
    readonly html: string;
    readonly section: string;
    readonly number: number;
  }>;
}
