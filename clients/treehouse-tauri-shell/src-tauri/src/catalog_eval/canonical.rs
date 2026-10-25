//! Bounded `lattice-cbor-v1` terms, independent of the webview and authority fold.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

pub const MAX_BYTES: usize = 128 * 1024;
pub const MAX_DEPTH: usize = 64;
pub const MAX_NODES: usize = 32_768;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub type Result<T> = std::result::Result<T, &'static str>;
const INVALID: &str = "catalog_envelope_invalid";
pub(crate) const MAX_OBSERVATION_INPUT: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy)]
struct Bounds {
    bytes: usize,
    nodes: usize,
    depth: usize,
}
const ARTIFACT: Bounds = Bounds {
    bytes: MAX_BYTES,
    nodes: MAX_NODES,
    depth: MAX_DEPTH,
};
// Domain op payload adds one list wrapper around its separately checked terms.
const OP_PAYLOAD: Bounds = Bounds {
    depth: MAX_DEPTH + 1,
    ..ARTIFACT
};
// A bounded source history may emit a larger canonical observation. This is an
// internal transient budget; artifact and persisted/transport limits do not move.
const OBSERVATION: Bounds = Bounds {
    bytes: MAX_OBSERVATION_INPUT * 2,
    nodes: MAX_OBSERVATION_INPUT,
    depth: MAX_DEPTH + 1,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Term {
    Nil,
    Bool(bool),
    Integer(u64),
    Binary(Vec<u8>),
    Atom(String),
    List(Vec<Term>),
    Tuple(Vec<Term>),
    Map(Vec<(Term, Term)>),
    Set(Vec<Term>),
    Delegation(Vec<Term>),
}

impl Term {
    pub fn from_carrier(value: &Value) -> Result<Self> {
        Self::from_bounded_carrier(value, ARTIFACT)
    }

    pub(crate) fn from_observation(value: &Value) -> Result<Self> {
        Self::from_bounded_carrier(value, OBSERVATION)
    }

    fn from_bounded_carrier(value: &Value, bounds: Bounds) -> Result<Self> {
        preflight(value, bounds)?;
        let mut nodes = 0;
        let term = parse(value, 0, &mut nodes, bounds)?;
        encode_bounded(&term, bounds)?;
        Ok(term)
    }

    pub fn atom_field(&self, name: &str) -> Option<&Self> {
        match self {
            Self::Map(pairs) => pairs.iter().find_map(|(key, value)| {
                if key == &Self::Atom(name.to_owned()) {
                    Some(value)
                } else {
                    None
                }
            }),
            _ => None,
        }
    }
}

pub fn base64(value: &str, length: Option<usize>) -> Result<Vec<u8>> {
    base64_bounded(value, length, ARTIFACT)
}

pub(crate) fn observation_base64(value: &str, length: Option<usize>) -> Result<Vec<u8>> {
    base64_bounded(value, length, OBSERVATION)
}

fn base64_bounded(value: &str, length: Option<usize>, bounds: Bounds) -> Result<Vec<u8>> {
    if value.len() > bounds.bytes * 2
        || length.is_some_and(|n| n.div_ceil(3).checked_mul(4) != Some(value.len()))
    {
        return Err(INVALID);
    }
    let bytes = STANDARD.decode(value).map_err(|_| INVALID)?;
    if STANDARD.encode(&bytes) != value || length.is_some_and(|size| bytes.len() != size) {
        return Err(INVALID);
    }
    Ok(bytes)
}

fn parse(value: &Value, depth: usize, nodes: &mut usize, bounds: Bounds) -> Result<Term> {
    *nodes += 1;
    if depth > MAX_DEPTH || *nodes > bounds.nodes {
        return Err(INVALID);
    }
    let tagged = value.as_array().ok_or(INVALID)?;
    let tag = tagged.first().and_then(Value::as_str).ok_or(INVALID)?;
    if tag == "nil" && tagged.len() == 1 {
        return Ok(Term::Nil);
    }
    if tagged.len() != 2 {
        return Err(INVALID);
    }
    let argument = &tagged[1];
    Ok(match tag {
        "bool" => Term::Bool(argument.as_bool().ok_or(INVALID)?),
        "int" => Term::Integer(integer(argument)?),
        "bin" => Term::Binary(base64_bounded(
            argument.as_str().ok_or(INVALID)?,
            None,
            bounds,
        )?),
        "atom" => {
            let name = argument.as_str().ok_or(INVALID)?;
            if name.len() > bounds.bytes {
                return Err(INVALID);
            }
            Term::Atom(name.to_owned())
        }
        "list" | "tuple" | "mapset" => {
            let values = argument.as_array().ok_or(INVALID)?;
            if values.len() > bounds.nodes {
                return Err(INVALID);
            }
            let terms = values
                .iter()
                .map(|v| parse(v, depth + 1, nodes, bounds))
                .collect::<Result<Vec<_>>>()?;
            match tag {
                "list" => Term::List(terms),
                "tuple" => Term::Tuple(terms),
                _ => Term::Set(terms),
            }
        }
        "map" => {
            let values = argument.as_array().ok_or(INVALID)?;
            if values.len() > bounds.nodes / 2 {
                return Err(INVALID);
            }
            let mut pairs = Vec::with_capacity(values.len());
            for pair in values {
                let pair = pair.as_array().filter(|p| p.len() == 2).ok_or(INVALID)?;
                pairs.push((
                    parse(&pair[0], depth + 1, nodes, bounds)?,
                    parse(&pair[1], depth + 1, nodes, bounds)?,
                ));
            }
            Term::Map(pairs)
        }
        "delegation" => Term::Delegation(delegation(argument, nodes, bounds)?),
        _ => return Err(INVALID),
    })
}

fn integer(value: &Value) -> Result<u64> {
    if let Some(text) = value.as_str() {
        if text.is_empty()
            || text.len() > 20
            || !text.bytes().all(|c| c.is_ascii_digit())
            || (text.len() > 1 && text.starts_with('0'))
        {
            return Err(INVALID);
        }
        text.parse().map_err(|_| INVALID)
    } else {
        value
            .as_u64()
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or(INVALID)
    }
}

fn delegation(value: &Value, nodes: &mut usize, bounds: Bounds) -> Result<Vec<Term>> {
    let object = value.as_object().ok_or(INVALID)?;
    const REQUIRED: [&str; 9] = [
        "id",
        "replica",
        "issuer",
        "audience",
        "parent_id",
        "ops",
        "roles",
        "live",
        "sig",
    ];
    if REQUIRED.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !REQUIRED.contains(&key.as_str()) && key != "expires_epoch")
    {
        return Err(INVALID);
    }
    let text = |key: &str| -> Result<Term> {
        let text = object[key]
            .as_str()
            .filter(|s| s.len() <= bounds.bytes)
            .ok_or(INVALID)?;
        Ok(Term::Binary(text.as_bytes().to_vec()))
    };
    let binary = |key: &str, size| -> Result<Term> {
        Ok(Term::Binary(base64_bounded(
            object[key].as_str().ok_or(INVALID)?,
            Some(size),
            bounds,
        )?))
    };
    let mut fields = vec![
        text("id")?,
        text("replica")?,
        binary("issuer", 32)?,
        binary("audience", 32)?,
        if object["parent_id"].is_null() {
            Term::Nil
        } else {
            text("parent_id")?
        },
    ];
    for key in ["ops", "roles"] {
        let values = object[key].as_array().ok_or(INVALID)?;
        if values.len() > bounds.nodes {
            return Err(INVALID);
        }
        let mut names = values
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| s.len() <= bounds.bytes)
                    .ok_or(INVALID)
            })
            .collect::<Result<Vec<_>>>()?;
        names.sort_unstable();
        names.dedup();
        fields.push(Term::List(
            names
                .into_iter()
                .map(|s| Term::Atom(s.to_owned()))
                .collect(),
        ));
    }
    fields.push(Term::Bool(object["live"].as_bool().ok_or(INVALID)?));
    fields.push(binary("sig", 64)?);
    if let Some(epoch) = object.get("expires_epoch").filter(|v| !v.is_null()) {
        fields.push(Term::Integer(integer(epoch)?));
    }
    *nodes += fields.len();
    if *nodes > bounds.nodes {
        return Err(INVALID);
    }
    Ok(fields)
}

pub fn encode(term: &Term) -> Result<Vec<u8>> {
    encode_bounded(term, ARTIFACT)
}

pub(crate) fn encode_op(term: &Term) -> Result<Vec<u8>> {
    encode_bounded(term, OP_PAYLOAD)
}
pub(crate) fn encode_observation(term: &Term) -> Result<Vec<u8>> {
    encode_bounded(term, OBSERVATION)
}

fn encode_bounded(term: &Term, bounds: Bounds) -> Result<Vec<u8>> {
    let mut writer = Writer {
        bytes: Vec::new(),
        nodes: 0,
        bounds,
    };
    writer.term(term, 0)?;
    Ok(writer.bytes)
}

struct Writer {
    bytes: Vec<u8>,
    nodes: usize,
    bounds: Bounds,
}
impl Writer {
    fn put(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.bounds.bytes.saturating_sub(self.bytes.len()) {
            return Err(INVALID);
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn major(&mut self, major: u8, size: u64) -> Result<()> {
        let prefix = major << 5;
        match size {
            0..=23 => self.put(&[prefix | size as u8]),
            24..=255 => self.put(&[prefix | 24, size as u8]),
            256..=65_535 => {
                self.put(&[prefix | 25])?;
                self.put(&(size as u16).to_be_bytes())
            }
            65_536..=4_294_967_295 => {
                self.put(&[prefix | 26])?;
                self.put(&(size as u32).to_be_bytes())
            }
            _ => {
                self.put(&[prefix | 27])?;
                self.put(&size.to_be_bytes())
            }
        }
    }
    fn array(&mut self, values: &[Term], depth: usize) -> Result<()> {
        self.major(4, values.len() as u64)?;
        for value in values {
            self.term(value, depth + 1)?;
        }
        Ok(())
    }
    fn term(&mut self, term: &Term, depth: usize) -> Result<()> {
        self.nodes += 1;
        if depth > self.bounds.depth || self.nodes > self.bounds.nodes {
            return Err(INVALID);
        }
        match term {
            Term::Nil => self.put(&[0xf6]),
            Term::Bool(value) => self.put(&[if *value { 0xf5 } else { 0xf4 }]),
            Term::Integer(value) => self.major(0, *value),
            Term::Binary(value) => {
                self.major(2, value.len() as u64)?;
                self.put(value)
            }
            Term::Atom(name) => {
                self.major(6, 60_000)?;
                self.major(2, name.len() as u64)?;
                self.put(name.as_bytes())
            }
            Term::List(values) => self.array(values, depth),
            Term::Tuple(values) => {
                self.major(6, 60_001)?;
                self.array(values, depth)
            }
            Term::Delegation(values) => {
                validate_delegation(values)?;
                self.major(6, 60_003)?;
                self.array(values, depth)
            }
            Term::Set(values) => {
                let mut encoded = self.children(values.iter(), depth)?;
                encoded.sort_unstable();
                if encoded.windows(2).any(|pair| pair[0] == pair[1]) {
                    return Err(INVALID);
                }
                self.major(6, 60_002)?;
                self.major(4, encoded.len() as u64)?;
                for value in encoded {
                    self.put(&value)?;
                }
                Ok(())
            }
            Term::Map(values) => {
                let mut encoded = Vec::new();
                let mut total = 0usize;
                for (key, value) in values {
                    let key = self.child(key, depth)?;
                    let value = self.child(value, depth)?;
                    total = total.checked_add(key.len() + value.len()).ok_or(INVALID)?;
                    if total > self.bounds.bytes {
                        return Err(INVALID);
                    }
                    encoded.push((key, value));
                }
                encoded.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                if encoded.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                    return Err(INVALID);
                }
                self.major(5, encoded.len() as u64)?;
                for (key, value) in encoded {
                    self.put(&key)?;
                    self.put(&value)?;
                }
                Ok(())
            }
        }
    }
    fn child(&mut self, term: &Term, depth: usize) -> Result<Vec<u8>> {
        let mut child = Writer {
            bytes: Vec::new(),
            nodes: self.nodes,
            bounds: self.bounds,
        };
        child.term(term, depth + 1)?;
        self.nodes = child.nodes;
        Ok(child.bytes)
    }
    fn children<'a>(
        &mut self,
        values: impl Iterator<Item = &'a Term>,
        depth: usize,
    ) -> Result<Vec<Vec<u8>>> {
        let mut encoded = Vec::new();
        let mut total = 0usize;
        for value in values {
            let value = self.child(value, depth)?;
            total = total.checked_add(value.len()).ok_or(INVALID)?;
            if total > self.bounds.bytes {
                return Err(INVALID);
            }
            encoded.push(value);
        }
        Ok(encoded)
    }
}

/// Decode exactly one canonical term. Re-encoding also rejects nonminimal lengths,
/// unsorted maps/sets and collisions before any authenticated consumer sees it.
pub fn decode(bytes: &[u8]) -> Result<Term> {
    if bytes.len() > MAX_BYTES {
        return Err(INVALID);
    }
    let mut reader = Reader {
        bytes,
        offset: 0,
        nodes: 0,
    };
    let term = reader.term(0)?;
    if reader.offset != bytes.len() || encode(&term)? != bytes {
        return Err(INVALID);
    }
    Ok(term)
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    nodes: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self.offset.checked_add(size).ok_or(INVALID)?;
        let value = self.bytes.get(self.offset..end).ok_or(INVALID)?;
        self.offset = end;
        Ok(value)
    }
    fn argument(&mut self, info: u8) -> Result<u64> {
        Ok(match info {
            0..=23 => u64::from(info),
            24 => u64::from(self.take(1)?[0]),
            25 => u64::from(u16::from_be_bytes(
                self.take(2)?.try_into().map_err(|_| INVALID)?,
            )),
            26 => u64::from(u32::from_be_bytes(
                self.take(4)?.try_into().map_err(|_| INVALID)?,
            )),
            27 => u64::from_be_bytes(self.take(8)?.try_into().map_err(|_| INVALID)?),
            _ => return Err(INVALID),
        })
    }
    fn term(&mut self, depth: usize) -> Result<Term> {
        self.nodes += 1;
        if depth > MAX_DEPTH || self.nodes > MAX_NODES {
            return Err(INVALID);
        }
        let prefix = self.take(1)?[0];
        let major = prefix >> 5;
        let info = prefix & 31;
        if major == 7 {
            return match info {
                20 => Ok(Term::Bool(false)),
                21 => Ok(Term::Bool(true)),
                22 => Ok(Term::Nil),
                _ => Err(INVALID),
            };
        }
        let argument = self.argument(info)?;
        match major {
            0 => Ok(Term::Integer(argument)),
            2 => {
                let size = usize::try_from(argument).map_err(|_| INVALID)?;
                Ok(Term::Binary(self.take(size)?.to_vec()))
            }
            4 | 5 => {
                let count = usize::try_from(argument).map_err(|_| INVALID)?;
                let width = if major == 5 { 2 } else { 1 };
                if count > (MAX_NODES - self.nodes) / width
                    || count > (self.bytes.len() - self.offset) / width
                {
                    return Err(INVALID);
                }
                if major == 4 {
                    let mut values = Vec::with_capacity(count);
                    for _ in 0..count {
                        values.push(self.term(depth + 1)?);
                    }
                    Ok(Term::List(values))
                } else {
                    let mut pairs = Vec::with_capacity(count);
                    for _ in 0..count {
                        pairs.push((self.term(depth + 1)?, self.term(depth + 1)?));
                    }
                    Ok(Term::Map(pairs))
                }
            }
            6 => {
                if !(60_000..=60_003).contains(&argument) {
                    return Err(INVALID);
                }
                let header = self.take(1)?[0];
                let size = usize::try_from(self.argument(header & 31)?).map_err(|_| INVALID)?;
                if argument == 60_000 {
                    if header >> 5 != 2 {
                        return Err(INVALID);
                    }
                    let text = std::str::from_utf8(self.take(size)?).map_err(|_| INVALID)?;
                    return Ok(Term::Atom(text.to_owned()));
                }
                if header >> 5 != 4
                    || size > MAX_NODES - self.nodes
                    || size > self.bytes.len() - self.offset
                {
                    return Err(INVALID);
                }
                let mut values = Vec::with_capacity(size);
                for _ in 0..size {
                    values.push(self.term(depth + 1)?);
                }
                match argument {
                    60_001 => Ok(Term::Tuple(values)),
                    60_002 => Ok(Term::Set(values)),
                    60_003 if matches!(values.len(), 9 | 10) => Ok(Term::Delegation(values)),
                    _ => Err(INVALID),
                }
            }
            _ => Err(INVALID),
        }
    }
}

// The Value entry point is also used by trusted native callers. Bound its whole
// shape before cloning any buffers; raw JSON parsing has its own byte cap.
fn preflight(value: &Value, bounds: Bounds) -> Result<()> {
    let mut stack = vec![(value, 0)];
    let mut nodes = 0usize;
    let mut text_bytes = 0usize;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        if nodes > bounds.nodes * 4 || depth > MAX_DEPTH * 2 + 2 {
            return Err(INVALID);
        }
        match value {
            Value::String(text) => {
                text_bytes = text_bytes.checked_add(text.len()).ok_or(INVALID)?
            }
            Value::Array(values) => {
                if values.len() + stack.len() > bounds.nodes * 4 {
                    return Err(INVALID);
                }
                stack.extend(values.iter().map(|v| (v, depth + 1)));
            }
            Value::Object(values) => {
                if values.len() + stack.len() > bounds.nodes * 4 {
                    return Err(INVALID);
                }
                for (key, value) in values {
                    text_bytes = text_bytes.checked_add(key.len()).ok_or(INVALID)?;
                    stack.push((value, depth + 1));
                }
            }
            _ => {}
        }
        if text_bytes > bounds.bytes {
            return Err(INVALID);
        }
    }
    Ok(())
}

fn validate_delegation(fields: &[Term]) -> Result<()> {
    if !matches!(fields.len(), 9 | 10) {
        return Err(INVALID);
    }
    for index in [0, 1] {
        match &fields[index] {
            Term::Binary(bytes) if std::str::from_utf8(bytes).is_ok() => {}
            _ => return Err(INVALID),
        }
    }
    for (index, length) in [(2, 32), (3, 32), (8, 64)] {
        if !matches!(&fields[index], Term::Binary(bytes) if bytes.len() == length) {
            return Err(INVALID);
        }
    }
    match &fields[4] {
        Term::Nil => {}
        Term::Binary(bytes) if std::str::from_utf8(bytes).is_ok() => {}
        _ => return Err(INVALID),
    }
    for index in [5, 6] {
        let Term::List(names) = &fields[index] else {
            return Err(INVALID);
        };
        let mut previous: Option<&str> = None;
        for name in names {
            let Term::Atom(name) = name else {
                return Err(INVALID);
            };
            if previous.is_some_and(|p| p >= name.as_str()) {
                return Err(INVALID);
            }
            previous = Some(name);
        }
    }
    if !matches!(fields[7], Term::Bool(_)) {
        return Err(INVALID);
    }
    if fields.len() == 10 && !matches!(fields[9], Term::Integer(epoch) if epoch <= MAX_SAFE_INTEGER)
    {
        return Err(INVALID);
    }
    Ok(())
}
