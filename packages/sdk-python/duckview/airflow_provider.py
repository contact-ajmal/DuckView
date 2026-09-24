"""Airflow provider metadata: registers the "duckview" connection type (Host = URL, Password = API token)."""


def get_provider_info() -> dict:
    return {
        "package-name": "duckview",
        "name": "DuckView",
        "description": "Run DuckView syncs, dbt projects, quality checks, reverse syncs, notebooks and SQL checks from Airflow.",
        "connection-types": [{"hook-class-name": "duckview.airflow.DuckViewHook", "connection-type": "duckview"}],
        "versions": ["0.1.0"],
    }
