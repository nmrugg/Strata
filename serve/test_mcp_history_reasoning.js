// #2100: the mirror of serve/test_mcp_round_history.py, on the real app.js.
// The web app must NOT send the thinking of a tool round back: run_with_mcp leaves it out of the prompt it hands the
// engine, and a history that carries it would no longer start with the tokens the engine already holds.
// Run with: node serve/test_mcp_history_reasoning.js
const fs = require("fs"), assert = require("assert");
const src = fs.readFileSync("/programs/Strata/serve/web/app.js", "utf8") + "\nreturn assistantMessages;";
const el = () => ({dataset: {}, attrs: {}, children: [], value: "", hidden: false, className: "", textContent: "",
  classList: {add() {}, remove() {}, toggle() {}}, style: {}, addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
  querySelector() { const n = el(); this.children.push(n); return n; }, querySelectorAll: () => [],
  setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, focus() {}, remove() {},
  scrollIntoView() {}, closest: () => null});
const env = {document: {getElementById: (id) => (el.cache = el.cache || {})[id] || (el.cache[id] = el()),
             createElement: () => el(), documentElement: {dataset: {}}, addEventListener() {}, querySelectorAll: () => []},
             localStorage: {getItem: () => null, setItem() {}}, indexedDB: {}, location: {hash: "", pathname: "/"},
             history: {replaceState() {}}, matchMedia: () => ({matches: false, addEventListener() {}}),
             fetch: async () => ({}), setTimeout: () => 0, requestAnimationFrame: () => 0,
             navigator: {clipboard: {writeText: async () => {}}}, innerWidth: 1200,
             window: {addEventListener() {}}, queueMicrotask: () => {}};
const assistantMessages = new Function(...Object.keys(env), src)(...Object.keys(env).map((k) => env[k]));

// two rounds: thinking "first I look" then "now I read", then a final answer with its own thinking
const m = {text: "Looking.\n\nReading.\n\nThe file has 3 lines.",
           reasoning: "first I look" + "now I read" + "tail note",
           tools: [{id: "c1", name: "srv__ls", round: 1, at: 0, rat: 12, result: "a.txt", state: "done", arguments: {p: "."}},
                   {id: "c2", name: "srv__read", round: 2, at: 9, rat: 22, result: "1 2 3", state: "done", arguments: {p: "a.txt"}}]};

const out = assistantMessages(m, false);
const asst = out.filter((x) => x.role === "assistant");
assert.strictEqual(asst.length, 3, "two round turns plus the final answer");
for (const a of asst.filter((x) => x.tool_calls))
  assert.ok(!("reasoning_content" in a), "off (the default): a tool round comes back without its thinking");
assert.ok(!("reasoning_content" in asst[2]), "off: the final answer turn likewise carries none");
assert.strictEqual(out.filter((x) => x.role === "tool").length, 2, "both results still go back");

// on: each round carries its own thinking, split at the length recorded when the call started (t.rat)
const on = assistantMessages(m, true).filter((x) => x.role === "assistant");
assert.strictEqual(on[0].reasoning_content, "first I look");
assert.strictEqual(on[1].reasoning_content, "now I read");
assert.deepStrictEqual(on[0].tool_calls && on[1].tool_calls ? [1, 1] : [0, 0], [1, 1], "the calls stay with their round");

// a turn with no tools is unchanged: no thinking unless there is no answer at all (#1392)
assert.deepStrictEqual(assistantMessages({text: "hi", reasoning: "thought"}), [{role: "assistant", content: "hi"}]);
assert.deepStrictEqual(assistantMessages({text: "", reasoning: "thought"}),
                       [{role: "assistant", content: "", reasoning_content: "thought"}]);
console.log("OK: off (default) drops the round thinking; on splits it per round; the no-tools shapes are unchanged");
