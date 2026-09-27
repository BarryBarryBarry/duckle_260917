//! Error type for the harness. Stringly-typed on the wire so it survives
//! the boundary to the frontend without leaking `?Sized` internals.

use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("transport: {0}")]
    Transport(String),

    #[error("mcp: {0}")]
    Mcp(String),

    #[error("llm: {0}")]
    Llm(String),

    #[error("json: {0}")]
    Json(String),

    #[error("timeout: {0}")]
    Timeout(String),

    #[error("cancelled")]
    Cancelled,
}
