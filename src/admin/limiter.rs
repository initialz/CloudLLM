//! 登录限速:进程内计数,邮箱 + 来源双维度。单实例内存态即可(重启清零是可接受取舍)。

use std::collections::HashMap;
use std::sync::Mutex;

const WINDOW_SECS: i64 = 900;
const MAX_FAILS: u32 = 5;
const LOCK_SECS: i64 = 900;

#[derive(Default)]
struct Entry {
    count: u32,
    window_start: i64,
    locked_until: i64,
}

#[derive(Default)]
pub struct LoginLimiter {
    map: Mutex<HashMap<String, Entry>>,
}

impl LoginLimiter {
    /// Err(解锁时刻) = 该维度处于锁定中
    pub fn check(&self, key: &str, now: i64) -> Result<(), i64> {
        let map = self.map.lock().expect("limiter 锁");
        match map.get(key) {
            Some(e) if e.locked_until > now => Err(e.locked_until),
            _ => Ok(()),
        }
    }

    pub fn record_failure(&self, key: &str, now: i64) {
        let mut map = self.map.lock().expect("limiter 锁");
        let e = map.entry(key.to_string()).or_default();
        if now - e.window_start > WINDOW_SECS {
            e.count = 0;
            e.window_start = now;
        }
        e.count += 1;
        if e.count >= MAX_FAILS {
            e.locked_until = now + LOCK_SECS;
            e.count = 0; // 锁定后重新计数,避免解锁瞬间再失败立刻又锁
        }
        // 顺手清理:超过 1000 条时丢弃过期项,防长期运行无界增长
        if map.len() > 1000 {
            map.retain(|_, v| v.locked_until > now || now - v.window_start <= WINDOW_SECS);
        }
    }

    pub fn clear(&self, key: &str) {
        self.map.lock().expect("limiter 锁").remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_after_five_failures_and_recovers() {
        let l = LoginLimiter::default();
        let t0 = 1_000_000;
        for i in 0..5 {
            assert!(l.check("email:a@x.com", t0 + i).is_ok());
            l.record_failure("email:a@x.com", t0 + i);
        }
        assert!(l.check("email:a@x.com", t0 + 10).is_err()); // 锁定
        assert!(l.check("email:a@x.com", t0 + 10 + 900).is_ok()); // 锁过期
    }

    #[test]
    fn success_clears_counter() {
        let l = LoginLimiter::default();
        for i in 0..4 {
            l.record_failure("email:b@x.com", 1_000 + i);
        }
        l.clear("email:b@x.com");
        assert!(l.check("email:b@x.com", 1_005).is_ok());
        l.record_failure("email:b@x.com", 1_005);
        assert!(l.check("email:b@x.com", 1_006).is_ok()); // 重新从 1 计
    }

    #[test]
    fn window_expiry_resets_count() {
        let l = LoginLimiter::default();
        for i in 0..4 {
            l.record_failure("email:c@x.com", 1_000 + i);
        }
        l.record_failure("email:c@x.com", 1_000 + 901); // 窗口已过,重开窗
        assert!(l.check("email:c@x.com", 1_000 + 902).is_ok());
    }
}
