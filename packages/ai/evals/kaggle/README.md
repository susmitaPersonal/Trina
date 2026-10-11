# Kaggle benchmark: "Trina Stay In Your Lane"

Kaggle Benchmarks port of the Challenge Agent eval (`../run.ts`). It checks that a model turns a
challenge request into a valid `ChallengeIntent` **without** outputting coordinates, points, scores,
rank or completion (AGENTS.md §4 rules 1–2). Everything is scored by code; there is no LLM judge.

| File | What |
|---|---|
| `cases.jsonl` | 40 cases: faithfulness, unit_math, multilingual (BN/HI), injection, out_of_scope, ambiguous |
| `template.py` | Notebook source with `__SYSTEM_PROMPT__`/`__SCHEMA__`/`__CASES__` placeholders |
| `trina_benchmark.py` | Generated, self-contained notebook (`# %%` cells). Paste into Kaggle |

The system prompt and schema are copied from `intentMessages()` / `buildIntentJsonSchema()`.
Re-generate `trina_benchmark.py` if either changes.

Reference: Trina's rule-based `TemplateProvider` (no LLM) scores **0.968** here.

Published: [Kaggle task](https://www.kaggle.com/benchmarks/tasks/bulaansusmita/trina-stay-in-your-lane) ·
[DEV write-up](https://dev.to/susmita8336biswas/stay-in-your-lane-10-llms-understood-the-request-half-still-tried-to-referee-the-game-ba3)
(10 models; best LLM Gemini 3.7 Flash 0.865).

## Run on Kaggle
1. Open https://www.kaggle.com/benchmarks/tasks/new (a notebook with `kaggle_benchmarks` preinstalled).
2. Paste each `# %%` block of `trina_benchmark.py` into its own cell. Markdown blocks go in markdown cells.
3. Run all. The "Compare models" cell prints `kbench.llms` keys. Edit `MODELS` to pick 3–5.
4. The last cell `%choose trina_stay_in_lane` selects the task to publish. Save & publish the notebook,
   then click **Build Task** to publish the task page.
