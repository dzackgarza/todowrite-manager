set fallback := true
repo_root := justfile_directory()
python_qc_justfile := "/home/dzack/ai/quality-control/justfile"

default:
    @just test

install:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv sync --dev

[private]
_format:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run ruff format .

[private]
_lint:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run ruff check .

[private]
_typecheck:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run basedpyright

[private]
_quality-control:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run pytest tests

test: _lint _typecheck _quality-control

check: test
