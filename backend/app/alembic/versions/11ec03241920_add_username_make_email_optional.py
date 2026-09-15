"""add username, make email optional

Revision ID: 11ec03241920
Revises: b7c41d9e2a55
Create Date: 2026-09-15 09:48:11.488920

Either identifier can now be used to sign in, and a person may have only one of them: hospital
staff are routinely issued a username and no mailbox, so requiring an address would have meant
inventing fake ones.

Autogenerate's ``jobs.kind`` alteration is dropped, as in the two preceding revisions. It is a
false positive from comparing a SQLite development database (enum stored as VARCHAR) against the
Postgres model (a native ENUM type); the Postgres type is already correct.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '11ec03241920'
down_revision = 'b7c41d9e2a55'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("username", sa.String(length=64), nullable=True))
        batch_op.alter_column("email", existing_type=sa.VARCHAR(length=255), nullable=True)
        batch_op.create_index(batch_op.f("ix_users_username"), ["username"], unique=True)


def downgrade() -> None:
    """Reversing this can fail, and that is the honest behaviour.

    Any account created with a username and no email cannot satisfy a NOT NULL email column. Rather
    than inventing an address to make the downgrade succeed, it is left to fail loudly — the
    operator then decides what those accounts should become.
    """
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_users_username"))
        batch_op.alter_column("email", existing_type=sa.VARCHAR(length=255), nullable=False)
        batch_op.drop_column("username")
