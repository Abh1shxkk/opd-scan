from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


_is_sqlite = settings.database_url.startswith("sqlite")

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    future=True,
    # SQLite's default is to fail "database is locked" immediately. The trial deployment runs jobs
    # inline in the request thread, so a long-running page (many provider calls) can hold a write
    # lock for a while; give other connections a real chance to wait it out instead of erroring.
    connect_args=({"check_same_thread": False, "timeout": 30} if _is_sqlite else {}),
)

if _is_sqlite:
    # WAL lets readers (page views, dashboard) proceed while a page's processing holds a write
    # transaction, instead of every reader queuing behind SQLite's default rollback-journal lock.
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
