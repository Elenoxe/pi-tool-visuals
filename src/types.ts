import Type, { type Static } from "typebox"

const positiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const closed = { additionalProperties: false }

const resolvedToolConfigSchema = Type.Object(
  { enabled: Type.Boolean(), collapsedLines: positiveInteger },
  closed,
)
const toolConfigSchema = Type.Partial(resolvedToolConfigSchema, closed)

export const toolVisualsConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    collapsedLines: positiveInteger,
    codemode: Type.Object(
      {
        script: Type.Object(
          { showCollapsed: Type.Boolean(), collapsedLines: positiveInteger },
          closed,
        ),
        calls: Type.Object({ collapsedCount: positiveInteger }, closed),
        output: Type.Object({ collapsedLines: positiveInteger }, closed),
        history: Type.Object({ maxBytes: positiveInteger }, closed),
      },
      closed,
    ),
    tools: Type.Record(Type.String({ pattern: "\\S" }), toolConfigSchema, closed),
  },
  closed,
)

export type ToolConfig = Static<typeof toolConfigSchema>
export type ResolvedToolConfig = Static<typeof resolvedToolConfigSchema>
export type ToolVisualsConfig = Static<typeof toolVisualsConfigSchema>

export interface ConfigDiagnostic {
  code: string
  message: string
}
