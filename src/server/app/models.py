from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TIMESTAMP


class Base(DeclarativeBase):
    pass


class ReleasePlanRow(Base):
    """A stored Release Plan board (specs/release_plan_persistence, table
    `release_plans`). Timestamps are `timestamptz`; `state` is the board JSON."""

    __tablename__ = "release_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    project_type: Mapped[str] = mapped_column(Text, nullable=False)
    project_name: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # NULL = unowned: visible to every signed-in user (boards that predate
    # users, or created through MCP). SET NULL keeps a deleted user's boards.
    owner_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    __table_args__ = (
        Index("ix_release_plans_updated_at_id", text("updated_at DESC"), text("id DESC")),
    )


class User(Base):
    """A signed-in Google account (table `users`), upserted by `sub` (the
    stable Google subject id) at every login."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sub: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    picture_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    last_login_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())


class AdoCredential(Base):
    """A user's stored Azure DevOps PAT for one project (table
    `ado_credentials`). `project_url` is the canonical URL from
    `parse_project_url`; `pat_encrypted` is the Fernet token of the PAT."""

    __tablename__ = "ado_credentials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    project_name: Mapped[str] = mapped_column(Text, nullable=False)
    project_url: Mapped[str] = mapped_column(Text, nullable=False)
    pat_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (UniqueConstraint("user_id", "project_url", name="uq_ado_credentials_user_id_project_url"),)
