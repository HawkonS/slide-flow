"""OpenAI-compatible model discovery behavior."""

import unittest
from unittest.mock import patch

import httpx

from app.services.model_connections import ModelConnectionError, list_remote_models


class ModelDiscoveryTests(unittest.TestCase):
    def response(self, payload, status_code=200):
        return httpx.Response(status_code, json=payload, request=httpx.Request("GET", "https://models.example/v1/models"))

    @patch("app.services.model_connections.httpx.get")
    def test_accepts_openai_data_and_deduplicates_models(self, get):
        get.return_value = self.response({"data": [{"id": "vision-a", "owned_by": "one"}, {"id": "vision-a"}, "vision-b"]})

        models = list_remote_models("https://models.example/v1", "secret")

        self.assertEqual(models, [
            {"id": "vision-a", "owned_by": "one"},
            {"id": "vision-b", "owned_by": ""},
        ])
        get.assert_called_once()

    @patch("app.services.model_connections.httpx.get")
    def test_accepts_compatible_models_shapes(self, get):
        get.return_value = self.response({"models": [{"model": "vision-a"}]})
        self.assertEqual(list_remote_models("https://models.example/v1/models", "secret")[0]["id"], "vision-a")

        get.return_value = self.response(["vision-b"])
        self.assertEqual(list_remote_models("https://models.example/v1/chat/completions", "secret")[0]["id"], "vision-b")

    @patch("app.services.model_connections.httpx.get")
    def test_reports_authentication_failure_without_remote_body(self, get):
        get.return_value = self.response({"error": "bad key"}, 401)

        with self.assertRaisesRegex(ModelConnectionError, "鉴权失败"):
            list_remote_models("https://models.example/v1", "secret")


if __name__ == "__main__":
    unittest.main()
