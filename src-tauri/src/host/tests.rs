use super::*;

/// A pool that runs the real worker binary (the unit-test binary cannot be one).
fn pool() -> Pool {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut pool = Pool::new(Some(manifest.join("pdfium"))).unwrap();
    // target/debug/deps/<test binary> -> target/debug/novapdf
    pool.exe = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("novapdf");
    assert!(pool.exe.exists(), "build the app binary first: {}", pool.exe.display());
    pool
}

fn layout() -> Request {
    serde_json::from_value(serde_json::json!({
        "op": "layout", "text": "one two", "font": {"family": "Helvetica"},
        "size": 12, "width": null
    }))
    .unwrap()
}

#[tokio::test]
async fn memory_watchdog_kills_a_worker_over_the_cap_and_the_pool_recovers() {
    let pool = pool();
    pool.warm().await;
    assert_eq!(pool.watched.lock().unwrap().len(), 1);

    // Under the real cap, a fresh worker is left alone.
    assert_eq!(pool.enforce_memory_cap(crate::sandbox::WORKER_MEMORY_LIMIT as u64), 0);
    pool.call(Lane::Interactive, layout(), RENDER_TIMEOUT).await.unwrap();

    // Over a tiny cap it is killed; the next request starts a replacement.
    assert_eq!(pool.enforce_memory_cap(1), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    pool.call(Lane::Interactive, layout(), RENDER_TIMEOUT).await.unwrap();

    // The dead worker drops out of the watch list; only the replacement remains.
    assert_eq!(pool.enforce_memory_cap(u64::MAX), 0);
    assert_eq!(pool.watched.lock().unwrap().len(), 1);
}
