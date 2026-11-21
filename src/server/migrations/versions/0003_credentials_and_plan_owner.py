"""ado credentials and release plan owner

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
    # NULL = unowned (boards that predate users or were created through MCP).
    # SET NULL keeps a deleted user's boards instead of destroying them; they
    # become visible to every signed-in user, like the other unowned boards.
    op.add_column("release_plans", sa.Column("owner_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_release_plans_owner_id_users", "release_plans", "users", ["owner_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("ix_release_plans_owner_id", "release_plans", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_release_plans_owner_id", table_name="release_plans")
    op.drop_constraint("fk_release_plans_owner_id_users", "release_plans", type_="foreignkey")
    op.drop_column("release_plans", "owner_id")
    op.drop_table("ado_credentials")
