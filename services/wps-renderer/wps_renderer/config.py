import json
import os
from dataclasses import dataclass, field, fields
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    wpscli: str
    data_dir: str
    token: str = field(repr=False)
    host: str = "127.0.0.1"
    port: int = 8765
    max_queue: int = 4
    max_upload_bytes: int = 128 * 1024 * 1024
    # One PPTX/font inside a bundle. Keep this below max_upload_bytes so the
    # manifest and ZIP headers always fit in the request body.
    max_input_file_bytes: int = 120 * 1024 * 1024
    max_expanded_bytes: int = 256 * 1024 * 1024
    max_output_bytes: int = 64 * 1024 * 1024
    max_total_bytes: int = 768 * 1024 * 1024
    min_free_bytes: int = 512 * 1024 * 1024
    min_free_ratio: float = 0.05
    max_pages: int = 4
    max_dpi: int = 300
    render_timeout_seconds: int = 120
    upload_timeout_seconds: int = 180
    download_timeout_seconds: int = 180
    retention_seconds: int = 600
    max_records: int = 128
    max_pixels: int = 40_000_000
    process_memory_limit_bytes: int = 1536 * 1024 * 1024
    allow_network_bind: bool = False
    # TLS is optional only for a loopback listener used through an SSH tunnel.
    # Any listener reachable by another host must terminate TLS itself; do not
    # rely on the caller to remember to put a reverse proxy in front of it.
    tls_cert_file: str = ""
    tls_key_file: str = ""

    def __post_init__(self):
        if len(self.token) < 32 or len(self.token) > 4096:
            raise ValueError("WPS_RENDER_TOKEN must be a random secret of at least 32 characters")
        if self.host not in {"127.0.0.1", "::1", "localhost"} and not self.allow_network_bind:
            raise ValueError("Network bind requires allow_network_bind=true and a private TLS reverse proxy/firewall")
        if bool(self.tls_cert_file) != bool(self.tls_key_file):
            raise ValueError("tls_cert_file and tls_key_file must be configured together")
        if self.host not in {"127.0.0.1", "::1", "localhost"} and (not self.tls_cert_file or not self.tls_key_file):
            raise ValueError("A non-loopback renderer listener requires a TLS certificate and private key")
        for name in ("tls_cert_file", "tls_key_file"):
            value = getattr(self, name)
            if value and not Path(value).is_file():
                raise ValueError(f"{name} does not exist: {value}")
        if not 1 <= self.port <= 65535 or not 1 <= self.max_queue <= 32:
            raise ValueError("Invalid port or queue limit")
        if not 1 <= self.max_pages <= 16 or not 72 <= self.max_dpi <= 600:
            raise ValueError("Invalid page or DPI limit")
        if not 0 <= self.min_free_ratio < 1:
            raise ValueError("Invalid minimum free-disk ratio")
        for name in ("max_upload_bytes", "max_expanded_bytes", "max_output_bytes", "max_total_bytes", "min_free_bytes", "render_timeout_seconds", "upload_timeout_seconds", "download_timeout_seconds", "retention_seconds", "max_records", "max_pixels", "process_memory_limit_bytes"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        if self.max_input_file_bytes > self.max_upload_bytes or self.max_input_file_bytes <= 0:
            raise ValueError("max_input_file_bytes must be positive and no larger than max_upload_bytes")
        if self.max_total_bytes < self.max_upload_bytes + self.max_expanded_bytes + self.max_output_bytes:
            raise ValueError("max_total_bytes must hold at least one reserved job")

    @classmethod
    def load(cls, path):
        values = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        token_file = values.pop("token_file", None)
        token = os.environ.get("WPS_RENDER_TOKEN", "")
        if not token and token_file:
            secret = Path(token_file)
            if not secret.is_absolute():
                secret = Path(path).resolve().parent / secret
            token = secret.read_text(encoding="utf-8").strip()
        if "token" in values:
            raise ValueError("Do not put token directly in config; use WPS_RENDER_TOKEN or token_file")
        unknown = set(values) - {f.name for f in fields(cls)}
        if unknown:
            raise ValueError(f"Unknown configuration keys: {sorted(unknown)}")
        values["token"] = token
        for name in ("data_dir", "wpscli", "tls_cert_file", "tls_key_file"):
            if name in values:
                if not values[name]:
                    continue
                target = Path(values[name]).expanduser()
                if not target.is_absolute():
                    target = Path(path).resolve().parent / target
                values[name] = str(target)
        return cls(**values)
