//! Verify-only calibration NIF for the G13 cost harness.
//!
//! The pinned profile `chide-es-r255-v1` (docs/research/m4_g2_profile_pin.md §2)
//! puts the entire coercion layer on ristretto255 with no pairing curve anywhere.
//! Its dominant verification cost is therefore variable-base scalar multiplication
//! (one "exponentiation" in the cost model) plus point addition. This NIF times
//! exactly those two primitives with curve25519-dalek and returns seconds/op.
//!
//! Deliberately NOT here: key generation, ballot construction, proof systems, or
//! any protocol state. Measuring anything beyond raw group operations would start
//! to look like an implementation of the profile, which is G3+ work this harness
//! must not preempt.

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use std::hint::black_box;
use std::time::Instant;

/// splitmix64 — cheap deterministic byte expansion for scalar inputs.
/// Scalar multiplication in curve25519-dalek is constant-time, so the scalar
/// values do not affect the timing; this only avoids degenerate scalars.
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn pseudo_scalar(state: &mut u64) -> Scalar {
    let mut bytes = [0u8; 32];
    for chunk in bytes.chunks_mut(8) {
        chunk.copy_from_slice(&splitmix64(state).to_le_bytes());
    }
    Scalar::from_bytes_mod_order(bytes)
}

/// Time `samples` variable-base scalar multiplications; return seconds per op.
fn time_scalar_mult(samples: u64) -> f64 {
    let mut state = 0x5EED_5EED_5EED_5EEDu64;
    // A non-basepoint variable base, so no fixed-base precomputation applies.
    let base: RistrettoPoint = RISTRETTO_BASEPOINT_POINT * pseudo_scalar(&mut state);
    let scalars: Vec<Scalar> = (0..64).map(|_| pseudo_scalar(&mut state)).collect();

    // Warmup outside the timed window.
    for s in scalars.iter().take(8) {
        black_box(black_box(base) * black_box(*s));
    }

    let start = Instant::now();
    for i in 0..samples {
        let s = scalars[(i % 64) as usize];
        black_box(black_box(base) * black_box(s));
    }
    start.elapsed().as_secs_f64() / samples as f64
}

/// Time `samples` point additions; return seconds per op.
fn time_point_add(samples: u64) -> f64 {
    let mut state = 0xADD5_EED5_ADD5_EED5u64;
    let points: Vec<RistrettoPoint> = (0..64)
        .map(|_| RISTRETTO_BASEPOINT_POINT * pseudo_scalar(&mut state))
        .collect();

    for i in 0..8usize {
        black_box(black_box(points[i]) + black_box(points[i + 1]));
    }

    let start = Instant::now();
    for i in 0..samples {
        let a = points[(i % 63) as usize];
        let b = points[((i % 63) + 1) as usize];
        black_box(black_box(a) + black_box(b));
    }
    start.elapsed().as_secs_f64() / samples as f64
}

/// Measure one primitive. DirtyCpu: the timed loop runs well past the 1 ms
/// scheduler budget for a normal NIF.
#[rustler::nif(schedule = "DirtyCpu")]
fn measure_op(op: &str, samples: u64) -> Result<f64, rustler::Error> {
    if samples == 0 {
        return Err(rustler::Error::BadArg);
    }

    match op {
        "scalar_mult" => Ok(time_scalar_mult(samples)),
        "point_add" => Ok(time_point_add(samples)),
        _ => Err(rustler::Error::BadArg),
    }
}

rustler::init!("Elixir.TownshipBench.GroupOps.Native");
