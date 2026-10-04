# Effect 3 construction example

Use this shape only when it fits the existing module. Effect.Service with established dependencies is also valid.

```ts
import { Context, Data, Effect, Layer } from "effect";

class LookupError extends Data.TaggedError("LookupError")<{
  readonly cause: unknown;
}> {}

interface DirectoryApi {
  readonly lookup: (id: string) => Effect.Effect<string, LookupError>;
}

class Directory extends Context.Tag("@app/Directory")<
  Directory,
  DirectoryApi
>() {}

// Supply a real adapter at the composition root.
const makeDirectory: Effect.Effect<DirectoryApi> = Effect.succeed({
  lookup: (id) => Effect.succeed(id),
});
const DirectoryLive = Layer.effect(Directory, makeDirectory);

// A faithful test implementation can be supplied through the same tag.
const DirectoryTest = Layer.succeed(Directory, {
  lookup: (id) => Effect.succeed(`test:${id}`),
});
```

This minimal example illustrates the tag and Layer API, not a production adapter. Real resource acquisition belongs in a scoped construction and should release resources on failure/interruption. Keep operation failure types tied to the capability; use Schema decoding at external boundaries.
