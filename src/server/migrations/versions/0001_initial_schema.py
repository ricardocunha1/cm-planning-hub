"""initial schema: users, release_plans, ado_credentials

Revision ID: 0001
Revises:
Create Date: 2026-11-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("sub", sa.Text(), nullable=False, unique=True),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("picture_url", sa.Text(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_login_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "release_plans",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("project_type", sa.Text(), nullable=False),
        sa.Column("project_name", sa.Text(), nullable=False),
        sa.Column("state", postgresql.JSONB(), nullable=False),
        # NULL = unowned (boards created through MCP). SET NULL keeps a deleted
        # user's boards instead of destroying them; they become visible to every
        # signed-in user, like the other unowned boards.
        sa.Column("owner_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_release_plans_owner_id_users", ondelete="SET NULL"
        ),
    )
    op.create_index(
        "ix_release_plans_updated_at_id",
        "release_plans",
        [sa.text("updated_at DESC"), sa.text("id DESC")],
    )
    op.create_index("ix_release_plans_owner_id", "release_plans", ["owner_id"])
    op.create_table(
        "ado_credentials",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_name", sa.Text(), nullable=False),
        sa.Column("project_url", sa.Text(), nullable=False),
        sa.Column("pat_encrypted", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "project_url", name="uq_ado_credentials_user_id_project_url"),
    )


def downgrade() -> None:
    op.drop_table("ado_credentials")
    op.drop_index("ix_release_plans_owner_id", table_name="release_plans")
    op.drop_index("ix_release_plans_updated_at_id", table_name="release_plans")
    op.drop_table("release_plans")
    op.drop_table("users")
