"""Private object storage with two interchangeable backends.

Nothing here is publicly readable. Files are served only through authenticated API routes
(see ``app/api/routes/files.py``) so that RBAC applies to previews and originals alike, not
just to the JSON API.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from typing import BinaryIO

from app.config import settings


class StorageBackend(ABC):
    @abstractmethod
    def put_bytes(self, key: str, data: bytes) -> str: ...

    @abstractmethod
    def put_stream(self, key: str, stream: BinaryIO) -> str: ...

    @abstractmethod
    def get_bytes(self, key: str) -> bytes: ...

    @abstractmethod
    def open_path(self, key: str) -> str:
        """Return a local filesystem path for the object (downloading if needed)."""

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...


class LocalStorage(StorageBackend):
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        # Defend against traversal: the resolved path must stay under root.
        p = (self.root / key).resolve()
        if not str(p).startswith(str(self.root)):
            raise ValueError("invalid storage key")
        return p

    def put_bytes(self, key: str, data: bytes) -> str:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        os.chmod(p, 0o600)
        return key

    def put_stream(self, key: str, stream: BinaryIO) -> str:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as fh:
            shutil.copyfileobj(stream, fh, length=1024 * 1024)
        os.chmod(p, 0o600)
        return key

    def get_bytes(self, key: str) -> bytes:
        return self._p(key).read_bytes()

    def open_path(self, key: str) -> str:
        return str(self._p(key))

    def exists(self, key: str) -> bool:
        return self._p(key).exists()

    def delete(self, key: str) -> None:
        p = self._p(key)
        if p.exists():
            p.unlink()


class S3Storage(StorageBackend):
    def __init__(self) -> None:
        import boto3

        self.bucket = settings.s3_bucket
        if not self.bucket:
            raise RuntimeError("S3 storage selected but S3_BUCKET is not set")
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
        )
        self._cache = Path(settings.storage_root) / "_s3cache"
        self._cache.mkdir(parents=True, exist_ok=True)

    def _extra(self) -> dict:
        if settings.s3_server_side_encryption:
            return {"ServerSideEncryption": settings.s3_server_side_encryption}
        return {}

    def put_bytes(self, key: str, data: bytes) -> str:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, **self._extra())
        return key

    def put_stream(self, key: str, stream: BinaryIO) -> str:
        self.client.upload_fileobj(stream, self.bucket, key, ExtraArgs=self._extra())
        return key

    def get_bytes(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def open_path(self, key: str) -> str:
        local = self._cache / hashlib.sha256(key.encode()).hexdigest()
        if not local.exists():
            local.write_bytes(self.get_bytes(key))
        return str(local)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


_backend: StorageBackend | None = None


def get_storage() -> StorageBackend:
    global _backend
    if _backend is None:
        _backend = S3Storage() if settings.storage_backend == "s3" else LocalStorage(settings.storage_root)
    return _backend


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
