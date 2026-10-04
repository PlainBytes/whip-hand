//! One terminal, several watchers (`pty-sizes.ts`). The desktop and a
//! browser report different sizes, and last-writer-wins would reflow the
//! terminal on every fit, so the smallest live size wins: letterboxed in the
//! larger window beats unreadable in the smaller one.

use std::collections::BTreeMap;

#[derive(Default)]
pub struct PtySizes {
    /// job -> client -> (cols, rows)
    by_job: BTreeMap<String, BTreeMap<u64, (u16, u16)>>,
}

impl PtySizes {
    /// Records one client's size for one job; returns the size to apply.
    pub fn report(&mut self, job_id: &str, client: u64, cols: u16, rows: u16) -> (u16, u16) {
        let per_client = self.by_job.entry(job_id.to_string()).or_default();
        per_client.insert(client, (cols, rows));
        per_client
            .values()
            .fold((cols, rows), |(c, r), (oc, or)| (c.min(*oc), r.min(*or)))
    }

    /// A disconnected client stops constraining every terminal it watched.
    pub fn forget(&mut self, client: u64) {
        self.by_job.retain(|_, per_client| {
            per_client.remove(&client);
            !per_client.is_empty()
        });
    }

    pub fn forget_job(&mut self, job_id: &str) {
        self.by_job.remove(job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_smallest_live_size_wins_until_its_client_goes() {
        let mut s = PtySizes::default();
        assert_eq!(s.report("j", 1, 120, 40), (120, 40));
        assert_eq!(s.report("j", 2, 80, 50), (80, 40));
        s.forget(2);
        assert_eq!(s.report("j", 1, 120, 40), (120, 40));
    }
}
