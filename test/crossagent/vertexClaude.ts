/**
 * vertex-claude crossagent smoke — disabled.
 * pullfrog GCP project has 0 quota for anthropic claude on vertex.
 * re-enable after quota increase.
 *
 * previous test definition (for restore):
 *   name: "vertex-claude"
 *   agents: ["claude"]
 *   prompt: Call set_output with "VERTEX CLAUDE SMOKE PASSED".
 *   env: PULLFROG_MODEL=vertex/byok, VERTEX_MODEL_ID=claude-opus-4-1@20250805, VERTEX_LOCATION=global
 */
