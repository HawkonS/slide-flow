class RenderError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def public(self):
        return {"code": self.code, "message": self.message}
