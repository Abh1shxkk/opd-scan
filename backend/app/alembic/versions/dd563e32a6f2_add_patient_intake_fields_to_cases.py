"""add patient intake fields to cases

Revision ID: dd563e32a6f2
Revises: 3f2938b32f54
Create Date: 2026-09-11 08:34:50.805154

Two deliberate departures from what autogenerate produced:

1. Every text column carries ``server_default=""``. The model defines a Python-side default, which
   does nothing for rows that already exist — adding a NOT NULL column to a populated ``cases``
   table without a server default fails outright on Postgres. The default is kept on the column
   afterwards rather than dropped, so a row inserted by anything that predates these fields still
   lands valid.

2. The ``jobs.kind`` alteration autogenerate suggested is dropped entirely. It is a false positive
   caused by comparing a SQLite development database (which stores the enum as VARCHAR) against the
   Postgres model (a native ENUM type). The Postgres type is already correct and was created by
   revision 3f2938b32f54; re-issuing an ALTER here would be a no-op at best and a destructive type
   rewrite at worst.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = 'dd563e32a6f2'
down_revision = '3f2938b32f54'
branch_labels = None
depends_on = None


# (column name, type) for the free-text intake fields, all of which default to an empty string.
_TEXT_COLUMNS = [
    ("patient_name", sa.String(length=255)),
    ("department", sa.String(length=128)),
    ("mobile", sa.String(length=32)),
    ("disease", sa.String(length=255)),
    ("icd_code", sa.String(length=32)),
    ("consultant_name", sa.String(length=255)),
    ("discharge_type", sa.String(length=64)),
    ("mlc_type", sa.String(length=64)),
]

# Dates are genuinely optional: "not recorded" is a real state on a discharge record and must stay
# distinguishable from any particular date.
_DATE_COLUMNS = ["admission_date", "discharge_date"]


def upgrade() -> None:
    with op.batch_alter_table("cases", schema=None) as batch_op:
        for name, coltype in _TEXT_COLUMNS:
            batch_op.add_column(sa.Column(name, coltype, nullable=False, server_default=""))
        for name in _DATE_COLUMNS:
            batch_op.add_column(sa.Column(name, sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("cases", schema=None) as batch_op:
        for name in reversed(_DATE_COLUMNS):
            batch_op.drop_column(name)
        for name, _ in reversed(_TEXT_COLUMNS):
            batch_op.drop_column(name)
