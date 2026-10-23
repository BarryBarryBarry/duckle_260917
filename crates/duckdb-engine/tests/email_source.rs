//! src.email against an IMAP server that runs inside the test.
//!
//! The server speaks just enough IMAP4rev1 for one read (greeting, CAPABILITY,
//! STARTTLS, LOGIN, SELECT, FETCH, LOGOUT) under a certificate from a CA minted
//! here. Duckle has to trust that CA through `DUCKLE_CA_CERT`, the way every
//! other TLS client it has does, which is what shows the connection runs on
//! Duckle's own TLS rather than on a copy bundled inside the IMAP library.
//!
//! `DUCKLE_CA_CERT` is set for this test binary only, which is its own
//! process, and the tests hold a lock so each sees the value it set.

use duckle_duckdb_engine::{DuckdbEngine, PipelineDoc};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::json;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};

static ENV: Mutex<()> = Mutex::new(());

const MESSAGE: &str = concat!(
    "From: Ada <ada@example.com>\r\n",
    "To: ops@example.com\r\n",
    "Subject: Quarterly numbers\r\n",
    "Date: Thu, 22 Oct 2026 09:00:00 +0000\r\n",
    "Message-ID: <q3@example.com>\r\n",
    "\r\n",
    "Revenue is up.\r\n",
);

fn engine() -> Option<DuckdbEngine> {
    let bin = std::env::var("DUCKLE_DUCKDB_BIN").ok()?;
    let p = std::path::PathBuf::from(bin);
    p.exists().then(|| DuckdbEngine::new(p))
}

/// A CA's certificate, and a server configured with a certificate it issued
/// for 127.0.0.1.
fn pki() -> (String, Arc<rustls::ServerConfig>) {
    let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca.distinguished_name.push(rcgen::DnType::CommonName, "Duckle test CA");
    let ca = rcgen::CertifiedIssuer::self_signed(ca, rcgen::KeyPair::generate().unwrap()).unwrap();
    let key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()])
        .unwrap()
        .signed_by(&key, &ca)
        .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(
        rustls::crypto::ring::default_provider().into(),
    )
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![leaf.der().clone()],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
    )
    .unwrap();
    (ca.pem(), Arc::new(config))
}

#[derive(Clone, Copy, PartialEq)]
enum Security {
    /// TLS from the first byte, as on port 993.
    Implicit,
    /// Plain text until the client asks for STARTTLS.
    StartTls,
    /// Plain text throughout, with no STARTTLS on offer.
    Plain,
}

/// Serve `connections` connections, one after another, and hand back every
/// command line received, each marked with whether it came under TLS.
fn serve(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
    security: Security,
    connections: usize,
) -> Arc<Mutex<Vec<String>>> {
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    std::thread::spawn(move || {
        for _ in 0..connections {
            let Ok((tcp, _)) = listener.accept() else { return };
            // A client that refuses the certificate ends the connection
            // mid-handshake. That is an outcome under test, not a server fault.
            let _ = serve_one(tcp, &config, security, &seen);
        }
    });
    log
}

fn serve_one(
    mut tcp: TcpStream,
    config: &Arc<rustls::ServerConfig>,
    security: Security,
    log: &Mutex<Vec<String>>,
) -> io::Result<()> {
    let tls = |tcp: TcpStream| -> io::Result<_> {
        let conn = rustls::ServerConnection::new(config.clone()).map_err(io::Error::other)?;
        Ok(rustls::StreamOwned::new(conn, tcp))
    };
    if security == Security::Implicit {
        let mut s = tls(tcp)?;
        say(&mut s, "* OK test server ready\r\n")?;
        return converse(&mut s, "tls", log);
    }
    say(&mut tcp, "* OK test server ready\r\n")?;
    loop {
        let line = hear(&mut tcp)?;
        log.lock().unwrap().push(format!("plain: {line}"));
        let (tag, command) = split(&line);
        match command.as_str() {
            "CAPABILITY" => {
                let caps = if security == Security::StartTls { "IMAP4rev1 STARTTLS" } else { "IMAP4rev1" };
                say(&mut tcp, &format!("* CAPABILITY {caps}\r\n{tag} OK CAPABILITY completed\r\n"))?;
            }
            "STARTTLS" if security == Security::StartTls => {
                say(&mut tcp, &format!("{tag} OK begin TLS now\r\n"))?;
                return converse(&mut tls(tcp)?, "tls", log);
            }
            _ => {
                if !answer(&mut tcp, &tag, &command)? {
                    return Ok(());
                }
            }
        }
    }
}

fn converse(s: &mut (impl Read + Write), via: &str, log: &Mutex<Vec<String>>) -> io::Result<()> {
    loop {
        let line = hear(s)?;
        log.lock().unwrap().push(format!("{via}: {line}"));
        let (tag, command) = split(&line);
        if !answer(s, &tag, &command)? {
            return Ok(());
        }
    }
}

/// Answer one command. False once the client has logged out.
fn answer(s: &mut impl Write, tag: &str, command: &str) -> io::Result<bool> {
    let reply = match command {
        "CAPABILITY" => format!("* CAPABILITY IMAP4rev1\r\n{tag} OK CAPABILITY completed\r\n"),
        "LOGIN" => format!("{tag} OK LOGIN completed\r\n"),
        "SELECT" => format!(
            "* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] UIDs valid\r\n{tag} OK [READ-WRITE] SELECT completed\r\n"
        ),
        "FETCH" => format!(
            "* 1 FETCH (UID 42 BODY[] {{{}}}\r\n{MESSAGE})\r\n{tag} OK FETCH completed\r\n",
            MESSAGE.len()
        ),
        "LOGOUT" => {
            say(s, &format!("* BYE logging out\r\n{tag} OK LOGOUT completed\r\n"))?;
            return Ok(false);
        }
        _ => format!("{tag} BAD unknown command\r\n"),
    };
    say(s, &reply)?;
    Ok(true)
}

fn say(s: &mut impl Write, text: &str) -> io::Result<()> {
    s.write_all(text.as_bytes())?;
    s.flush()
}

/// One CRLF-terminated line, read a byte at a time so nothing past it is
/// consumed: after STARTTLS the next byte belongs to the TLS handshake.
fn hear(s: &mut impl Read) -> io::Result<String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while !line.ends_with(b"\r\n") {
        if s.read(&mut byte)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        line.push(byte[0]);
    }
    line.truncate(line.len() - 2);
    Ok(String::from_utf8_lossy(&line).into_owned())
}

fn split(line: &str) -> (String, String) {
    let mut words = line.split(' ');
    let tag = words.next().unwrap_or_default().to_string();
    (tag, words.next().unwrap_or_default().to_ascii_uppercase())
}

fn email_to_csv(port: u16, out: &str) -> PipelineDoc {
    serde_json::from_value(json!({
        "nodes": [
            { "id": "mail", "position": { "x": 0, "y": 0 },
              "data": { "label": "mail", "componentId": "src.email", "properties": {
                  "host": "127.0.0.1", "port": port, "user": "ops",
                  "password": "not-a-real-password", "mailbox": "INBOX" } } },
            { "id": "out", "position": { "x": 0, "y": 0 },
              "data": { "label": "out", "componentId": "snk.csv",
                        "properties": { "path": out, "hasHeader": true } } }
        ],
        "edges": [ { "id": "e", "source": "mail", "target": "out", "data": { "connectionType": "main" } } ]
    }))
    .unwrap()
}

/// Run against `port` twice: refused without the CA, read with it.
fn refused_then_read(engine: &DuckdbEngine, port: u16, ca_pem: &str, log: &Mutex<Vec<String>>) {
    let tmp = tempfile::tempdir().unwrap();
    let ca = tmp.path().join("ca.pem");
    std::fs::write(&ca, ca_pem).unwrap();
    let out = tmp.path().join("mail.csv").to_string_lossy().replace('\\', "/");

    std::env::remove_var("DUCKLE_CA_CERT");
    let r = engine.execute_pipeline(&email_to_csv(port, &out));
    let error = r.error.unwrap_or_default();
    assert_eq!(r.status, "error", "a certificate from an unknown CA was accepted");
    assert!(error.contains("certificate"), "refused for the wrong reason: {error}");

    std::env::set_var("DUCKLE_CA_CERT", &ca);
    let r = engine.execute_pipeline(&email_to_csv(port, &out));
    std::env::remove_var("DUCKLE_CA_CERT");
    assert_eq!(r.status, "ok", "{:?}", r.error);
    let csv = std::fs::read_to_string(Path::new(&out)).unwrap();
    for want in ["42", "ada@example.com", "ops@example.com", "Quarterly numbers", "Revenue is up."] {
        assert!(csv.contains(want), "{want} missing from\n{csv}");
    }
    let log = log.lock().unwrap();
    assert!(log.iter().any(|l| l.starts_with("tls: ") && l.contains("LOGIN")), "{log:?}");
    assert!(!log.iter().any(|l| l.starts_with("plain: ") && l.contains("LOGIN")), "{log:?}");
}

#[test]
fn a_starttls_server_is_trusted_through_duckle_ca_cert() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let Some(engine) = engine() else {
        eprintln!("skipping: set DUCKLE_DUCKDB_BIN to run");
        return;
    };
    let (ca_pem, config) = pki();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = serve(listener, config, Security::StartTls, 2);
    refused_then_read(&engine, port, &ca_pem, &log);
}

/// Port 993 is the one port Duckle opens with TLS straight away, so this needs
/// that port. Where the OS reserves it (Linux, for an unprivileged user) the
/// test says so and stops.
#[test]
fn an_implicit_tls_server_on_993_is_trusted_through_duckle_ca_cert() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let Some(engine) = engine() else {
        eprintln!("skipping: set DUCKLE_DUCKDB_BIN to run");
        return;
    };
    let listener = match TcpListener::bind("127.0.0.1:993") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("skipping: cannot listen on 993 here ({e})");
            return;
        }
    };
    let (ca_pem, config) = pki();
    let log = serve(listener, config, Security::Implicit, 2);
    refused_then_read(&engine, 993, &ca_pem, &log);
}

#[test]
fn a_server_without_starttls_is_never_sent_the_password() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let Some(engine) = engine() else {
        eprintln!("skipping: set DUCKLE_DUCKDB_BIN to run");
        return;
    };
    let (_, config) = pki();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = serve(listener, config, Security::Plain, 1);
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("mail.csv").to_string_lossy().replace('\\', "/");

    let r = engine.execute_pipeline(&email_to_csv(port, &out));
    assert_eq!(r.status, "error", "read a mailbox over plain text");
    let log = log.lock().unwrap();
    assert!(!log.iter().any(|l| l.contains("LOGIN")), "the password went out in the clear: {log:?}");
}
