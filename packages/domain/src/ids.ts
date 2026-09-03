import { Schema } from "effect";

export const ToolCallId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;
