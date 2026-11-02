// Released age 0.12.1 in a separate graph, without the modern ML-KEM dependency.
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let dir = std::path::Path::new(&args[2]);
    let passphrase = age::secrecy::SecretString::from("compatibility test only".to_owned());
    let plaintext = b"bounded compatibility probe, no real credentials";
    match args[1].as_str() {
        "encrypt" => {
            let recipient = age::scrypt::Recipient::new(passphrase);
            let ciphertext = age::encrypt(&recipient, plaintext).unwrap();
            std::fs::write(dir.join("released.age"), ciphertext).unwrap();
            println!("released age 0.12.1 ciphertext created");
        }
        "decrypt" => {
            let identity = age::scrypt::Identity::new(passphrase);
            let ciphertext = std::fs::read(dir.join("upstream.age")).unwrap();
            assert_eq!(age::decrypt(&identity, &ciphertext).unwrap(), plaintext);
            println!("released age 0.12.1 decrypted upstream ciphertext");
        }
        _ => panic!("expected encrypt or decrypt"),
    }
}
