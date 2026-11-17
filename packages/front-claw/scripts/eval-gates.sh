#!/usr/bin/env bash
# 三道门 + 第四道门（延迟）评测：把任意同格式 jsonl 语料喂给员工入口，输出三道门数字、每条结果、总延迟与快通道/模型分类 p50/p95。
# D136 另有单列指标：归属和复合剥完仍有备注的标准行中，因备注不在白名单而被追问的条数、比例（按最终结果，门槛 ≤5%）、类别分布，写入摘要（remark_whitelist_ask）。
# 模型超时默认读系统 DEFAULT_MODEL_TIMEOUT_MS（8 秒），可用 --timeout-ms / 配置覆盖。
# 用法：
#   scripts/eval-gates.sh --corpus <jsonl> [--out <json>] [--config <配置>] [--model stub|live] [--timeout-ms N]
# 模型默认桩，不调真模型。门③与门④数字只记录，达标与否待正式实测再判。默认超时与系统配置同一处（8 秒）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
unset GIT_INDEX_FILE

CORPUS=""
OUT=""
CONFIG=""
MODEL=""
TIMEOUT=""
HELP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus|-c) CORPUS="${2:-}"; shift 2 ;;
    --out|-o) OUT="${2:-}"; shift 2 ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --timeout-ms) TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) HELP=1; shift ;;
    --) shift; break ;;
    -*)
      echo "未知参数：$1" >&2
      echo "用法：scripts/eval-gates.sh --corpus <jsonl> [--out <json>] [--config <配置>] [--model stub|live] [--timeout-ms N]" >&2
      exit 2
      ;;
    *)
      if [[ -z "$CORPUS" ]]; then CORPUS="$1"; shift; else echo "未知参数：$1" >&2; exit 2; fi
      ;;
  esac
done

if [[ "$HELP" -eq 1 ]]; then
  echo "用法：scripts/eval-gates.sh --corpus <jsonl> [--out <json>] [--config <配置>] [--model stub|live] [--timeout-ms N]"
  echo "模型默认桩，不调真模型。门③与门④数字只记录，达标与否待正式实测再判。默认超时与系统配置同一处（8 秒）。"
  exit 0
fi
if [[ -z "$CORPUS" ]]; then
  echo "用法：scripts/eval-gates.sh --corpus <jsonl> [--out <json>] [--config <配置>] [--model stub|live] [--timeout-ms N]" >&2
  exit 2
fi
if [[ ! -f "$CORPUS" ]]; then
  echo "语料不存在：$CORPUS" >&2
  exit 2
fi

# 绝对路径，避免 vitest 改 cwd 后找不到。
abs() { python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$1"; }
export FC_EVAL_CORPUS="$(abs "$CORPUS")"
if [[ -n "$OUT" ]]; then export FC_EVAL_OUT="$(abs "$OUT")"; else unset FC_EVAL_OUT || true; fi
if [[ -n "$CONFIG" ]]; then export FC_EVAL_CONFIG="$(abs "$CONFIG")"; export FC_MODEL_CONFIG="$(abs "$CONFIG")"; else unset FC_EVAL_CONFIG || true; fi
if [[ -n "$MODEL" ]]; then export FC_MODEL_MODE="$MODEL"; fi
if [[ -n "$TIMEOUT" ]]; then export FC_MODEL_TIMEOUT_MS="$TIMEOUT"; fi
export FC_EVAL_RUNNING=1

# 用 vitest 跑 TypeScript 入口（仓库无 tsx）。本文件在未设 FC_EVAL_RUNNING 时跳过，不影响普通单测。
LOG="$(mktemp)"
set +e
./node_modules/.bin/vitest run tests/r7/eval-gates-run.test.ts --reporter=dot >"$LOG" 2>&1
CODE=$?
set -e
# 入口把摘要写在分隔符之间，转给调用方；失败时再附 vitest 日志。
if grep -q '^---FC-EVAL-SUMMARY---$' "$LOG"; then
  python3 - << 'PY' "$LOG"
import sys
text = open(sys.argv[1], encoding='utf-8').read()
a = text.find('---FC-EVAL-SUMMARY---\n')
b = text.find('\n---FC-EVAL-END---')
if a >= 0 and b > a:
    print(text[a+len('---FC-EVAL-SUMMARY---\n'):b])
PY
fi
if [[ $CODE -ne 0 ]]; then
  echo "评测进程退出码 $CODE" >&2
  tail -n 80 "$LOG" >&2
  rm -f "$LOG"
  exit $CODE
fi
rm -f "$LOG"
