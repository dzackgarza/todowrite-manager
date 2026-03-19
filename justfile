set fallback := true

install:
    uv sync --dev

lint:
    .venv/bin/python -m ruff check .

format:
    .venv/bin/python -m ruff format .

typecheck:
    .venv/bin/python -m basedpyright

test:
    .venv/bin/python -m pytest

check: lint typecheck test
