#!/usr/bin/env bash
set -euo pipefail
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe='import sys; sys.exit(0 if sys.version_info[:3] == (3, 9, 11) else 1)'
python_command=''

if [[ -n "${REVIEWX_PYTHON:-}" ]]; then
    if "$REVIEWX_PYTHON" -c "$probe" 2>/dev/null; then
        python_command="$REVIEWX_PYTHON"
    fi
else
    for candidate in "$root/.venv/bin/python" python3.9 python3 python; do
        if "$candidate" -c "$probe" 2>/dev/null; then
            python_command="$candidate"
            break
        fi
    done
fi

if [[ -z "$python_command" ]]; then
    echo 'Python 3.9.11 is required. Install it or set REVIEWX_PYTHON to its executable path.' >&2
    exit 1
fi

exec "$python_command" "$root/scripts/deploy.py" "$@"
