// SPDX-License-Identifier: MIT
//! Compact native history. Attachments belong to a turn and remain inbox references.
use crate::claude::ChatContext;

#[derive(Clone)]
pub(crate) struct Turn {
    pub role: &'static str,
    pub text: String,
    pub context: Option<ChatContext>,
}
impl Turn {
    pub fn user(text: String, context: Option<ChatContext>) -> Self {
        Self {
            role: "user",
            text,
            context,
        }
    }
    pub fn assistant(text: String) -> Self {
        Self {
            role: "assistant",
            text,
            context: None,
        }
    }
}

pub(crate) fn trim(history: &mut Vec<Turn>) {
    while history.len() > 2
        && (history.len() > 64
            || history.iter().map(|turn| turn.text.len()).sum::<usize>() > 128_000
            || history.iter().filter(|turn| turn.context.is_some()).count() > 4)
    {
        // Remove complete turn pairs, including their attachment references.
        history.drain(0..2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trimming_keeps_attachment_with_its_turn_and_bounds_history() {
        let mut turns = Vec::new();
        for i in 0..40 {
            turns.push(Turn::user(
                format!("question {i}"),
                Some(ChatContext::File {
                    name: format!("file-{i}.txt"),
                    path: format!("inbox/file-{i}.txt"),
                }),
            ));
            turns.push(Turn::assistant("a".repeat(4000)));
        }
        trim(&mut turns);
        assert_eq!(turns.len(), 8);
        assert_eq!(turns[0].text, "question 36");
        assert!(
            matches!(&turns[0].context, Some(ChatContext::File { name, .. }) if name == "file-36.txt")
        );
        assert_eq!(turns.last().unwrap().role, "assistant");
        assert!(turns.iter().map(|turn| turn.text.len()).sum::<usize>() <= 128_000);
    }
}
