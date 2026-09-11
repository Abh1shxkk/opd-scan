"""add record_date to cases

The date the record was entered, which is not always today: a records team digitising a backlog is
typing a form that was filled in years ago, and the date printed on that form is the one that
belongs on the record. Nullable, because every case created before this column existed genuinely
has no answer — and a NULL here reads as "not recorded", never as a guess.

Revision ID: b7c41d9e2a55
Revises: dd563e32a6f2
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b7c41d9e2a55"
down_revision = "dd563e32a6f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cases", sa.Column("record_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("cases", "record_date")
