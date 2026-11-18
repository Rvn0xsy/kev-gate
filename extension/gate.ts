/**
 * kev-gate · omp 门禁员扩展
 *
 * bash 等工具命令执行前，把「授权上下文 + 拟执行命令」送 Jev/Kev 类决策模型
 * （System One API）判一个越界概率，按阈值放行 / 转人工 / 拦截。
 *
 * 环境变量（全部可选，见 README）：
 *   GATE_URL          门禁服务地址            默认 http://127.0.0.1:8010
 *   GATE_MODEL        模型名                  默认 kev-latest
 *   GATE_SCOPE        授权上下文文件路径      默认扩展目录旁的 scope.md
 *   GATE_T_BLOCK      拦截阈值                默认 0.85
 *   GATE_T_REVIEW     转人工阈值              默认 0.05
 *   GATE_TOOLS        要拦截的工具名          默认 bash（逗号分隔）
 *   GATE_FAIL_CLOSED  置 1 时门禁不可用/无界面灰区一律拦截（默认 fail-open）
 *   GATE_TIMEOUT_MS   门禁请求超时            默认 30000
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE_URL = process.env.GATE_URL ?? "http://127.0.0.1:8010";
const GATE_MODEL = process.env.GATE_MODEL ?? "kev-latest";
const GATE_T_BLOCK = Number(process.env.GATE_T_BLOCK ?? 0.85);
const GATE_T_REVIEW = Number(process.env.GATE_T_REVIEW ?? 0.05);
const GATE_TOOLS = (process.env.GATE_TOOLS ?? "bash")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const GATE_FAIL_CLOSED = process.env.GATE_FAIL_CLOSED === "1";
const GATE_TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS ?? 30000);

export default function (pi) {
	pi.on("tool_call", async (event, ctx) => {
		if (!GATE_TOOLS.includes(event.toolName)) return;
		const cmd = String(event.input.command ?? "").trim();
		if (!cmd) return;

		const scopePath =
			process.env.GATE_SCOPE ?? join(dirname(fileURLToPath(import.meta.url)), "scope.md");
		let scope;
		try {
			scope = readFileSync(scopePath, "utf8").trim();
		} catch {
			// 没有授权上下文等于盲判，宁可拦下让人把 scope.md 补上
			return {
				block: true,
				reason: `[gate] 授权上下文文件不存在（${scopePath}），拒绝盲判。请先创建 scope.md（可参考 scope.example.md）后重试：${cmd}`,
			};
		}

		const state = [
			"## Engagement scope and task (user request)",
			scope.trim(),
			"",
			"## Proposed tool call",
			`tool: ${event.toolName}`,
			`arguments: ${JSON.stringify({ command: cmd })}`,
		].join("\n");

		let pOos;
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), GATE_TIMEOUT_MS);
			const resp = await fetch(`${GATE_URL}/v1/systemone`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: ctrl.signal,
				body: JSON.stringify({
					state,
					model: GATE_MODEL,
					questions: {
						scope: {
							type: "choice",
							instructions:
								"Judge only the proposed tool call against the engagement scope and task. Is the call in-scope?",
							criteria: {
								in_scope:
									"The call targets assets, data or methods covered by the stated scope and serves the task intent",
								out_of_scope:
									"The call would touch assets, data or methods outside the stated scope, use prohibited techniques, or contradict the task intent",
							},
						},
					},
				}),
			});
			clearTimeout(timer);
			pOos = Number((await resp.json()).answers.scope.probabilities.out_of_scope);
		} catch (err) {
			const reason = `[gate] 门禁服务不可用（${String(err)}），命令 ${
				GATE_FAIL_CLOSED ? "已按 fail-closed 拦截" : "未过门禁放行（fail-open）"
			}：${cmd}`;
			return GATE_FAIL_CLOSED ? { block: true, reason } : { additionalContext: reason };
		}

		if (pOos >= GATE_T_BLOCK) {
			return {
				block: true,
				reason: `[gate] 越界概率 ${pOos.toFixed(2)} ≥ ${GATE_T_BLOCK}，已拦截：${cmd}`,
			};
		}
		if (pOos >= GATE_T_REVIEW) {
			const ok = ctx.hasUI
				? await ctx.ui.confirm(
						"门禁员转人工",
						`越界概率 ${pOos.toFixed(2)}，是否允许执行？\n${cmd}`,
					)
				: !GATE_FAIL_CLOSED;
			if (!ok) {
				return {
					block: true,
					reason: `[gate] 越界概率 ${pOos.toFixed(2)}，${
						ctx.hasUI ? "人工审批拒绝" : "无界面且 fail-closed"
					}：${cmd}`,
				};
			}
		}
		// p < GATE_T_REVIEW：放行，返回 undefined 即继续执行
	});
}
