//! `crypto.randomBytes` and `crypto.randomUUID`.

fn bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    buf
}

/// `randomBytes(n).toString('hex')`.
pub fn hex(n: usize) -> String {
    let mut out = String::with_capacity(n * 2);
    for chunk in 0..n.div_ceil(16) {
        let b = bytes::<16>();
        let take = (n - chunk * 16).min(16);
        for byte in &b[..take] {
            out.push_str(&format!("{byte:02x}"));
        }
    }
    out
}

/// `randomUUID()`: a version-4 UUID, lowercase, hyphenated.
pub fn uuid_v4() -> String {
    let mut b = bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn shapes() {
        assert_eq!(super::hex(4).len(), 8);
        assert_eq!(super::hex(20).len(), 40);
        let u = super::uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }
}
