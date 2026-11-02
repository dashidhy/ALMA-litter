fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "tah_ui", "tah_theme", "tah_working_stream", "tah_working_ack", "tah_working_unsubscribe",
        ]),
    )).expect("Invalid mobile TAH configuration");
}
