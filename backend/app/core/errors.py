class DomainError(Exception):
    """Base domain exception."""


class ValidationError(DomainError):
    """Raised when a request or state transition is invalid."""


class NotFoundError(DomainError):
    """Raised when an entity cannot be found."""


class StateTransitionError(DomainError):
    """Raised when a state transition is not allowed."""


class ToolExecutionError(DomainError):
    """Raised when a tool cannot be executed."""


class ExternalServiceError(DomainError):
    """Raised when an external service is unavailable or returns an error."""
