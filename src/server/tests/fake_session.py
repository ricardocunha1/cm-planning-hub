"""A scripted stand-in for `AsyncSession` for unit tests that must not touch
PostgreSQL: each `execute` pops the next scripted row list (empty when the
script is used up) and records the statement for inspection."""
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.dialects import postgresql


class FakeResult:
    def __init__(self, rows: list[Any], rowcount: int = 0) -> None:
        self.rows = rows
        self.rowcount = rowcount

    def scalar_one_or_none(self) -> Any:
        return self.rows[0] if self.rows else None

    def scalar_one(self) -> Any:
        return self.rows[0]

    def scalars(self) -> list[Any]:
        return list(self.rows)

    def first(self) -> Any:
        return (self.rows[0],) if self.rows else None


class FakeSession:
    def __init__(
        self, *results: list[Any], rowcount: int = 0, scalar_value: Any = 0, users: dict[int, Any] | None = None
    ) -> None:
        self.results = list(results)
        self.rowcount = rowcount
        self.scalar_value = scalar_value
        self.users = users or {}
        self.statements: list[Any] = []
        self.added: list[Any] = []
        self.commits = 0
        self.rollbacks = 0
        self.commit_error: Exception | None = None

    async def execute(self, statement: Any) -> FakeResult:
        self.statements.append(statement)
        return FakeResult(self.results.pop(0) if self.results else [], self.rowcount)

    async def scalar(self, statement: Any) -> Any:
        self.statements.append(statement)
        return self.scalar_value

    async def get(self, model: Any, key: Any) -> Any:
        return self.users.get(key)

    def add(self, row: Any) -> None:
        self.added.append(row)

    async def commit(self) -> None:
        if self.commit_error is not None:
            raise self.commit_error
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def refresh(self, row: Any) -> None:
        if getattr(row, "id", None) is None:
            row.id = 1
        for column in ("created_at", "updated_at"):
            if hasattr(row, column) and not isinstance(getattr(row, column), datetime):
                setattr(row, column, datetime(2026, 1, 1, tzinfo=timezone.utc))  # the database defaults

    def sql(self, index: int = -1) -> str:
        """The recorded statement as PostgreSQL SQL with the values inlined."""
        return str(
            self.statements[index].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
        )
