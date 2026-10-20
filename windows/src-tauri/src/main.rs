// SPDX-License-Identifier: MIT
// Mimo runs without a console window: Mimo is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kumo_lib::run()
}
