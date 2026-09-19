//! duckle-deepseek-harness
//!
//! A blocking ACP client for driving DeepSeek Harness (`dsh --profile acp`)
//! from Duckle's desktop shell.

pub mod acp_client;
pub mod error;
pub mod event;

pub use acp_client::{AcpModelOverride, AcpSelectedModel, AcpSession, DshLaunchSpec};
pub use error::{Error, Result};
pub use event::HarnessEvent;
