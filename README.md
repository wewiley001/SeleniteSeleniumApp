# Selenium Function Queue Runner

A desktop GUI application for building and executing Selenium browser automation sequences without writing code. Built with Python, tkinter, and Selenium WebDriver.

## Features

- Visual queue builder — add, reorder, and remove automation steps via GUI
- Supports **Chrome**, **Firefox**, and **Edge** browsers
- Per-step configuration: enable/disable, set delay (seconds), input arguments
- Tooltip descriptions for every function
- Save and load named queue scripts as JSON files
- Two execution modes: **close browser after completion** or **loop continuously**
- Stop execution at any time

## Requirements

- Python 3.x
- Google Chrome / Firefox / Microsoft Edge (with matching WebDriver)
- Dependencies:

```
pip install selenium
```

> Ensure the appropriate WebDriver (`chromedriver`, `geckodriver`, `msedgedriver`) is installed and available in your system `PATH`.

## Usage

```bash
python main.py
```

### Building a Queue (Manual Mode)

1. Select **Manual** mode.
2. Choose a browser (Chrome, Firefox, or Edge).
3. Enter the target URL (must start with `http` or `https`).
4. Click **+ Add Function to Queue** to add steps.
5. For each step:
   - Select a function from the dropdown.
   - Fill in required arguments.
   - Optionally set a delay (seconds) before execution.
   - Use ✓ **Enable** to toggle the step on/off.
   - Use **↑ / ↓** to reorder, **❌** to remove.
6. Choose an execution mode and click **▶ Execute Queue**.

### Saving a Queue

1. Enter a name in the **Custom Script Name** field.
2. Click **💾 Save Queue** — the queue is saved as a `.json` file in the `custom/` folder.

### Loading a Saved Queue (Custom Mode)

1. Select **Custom** mode.
2. Choose a script from the **Load Custom Script** dropdown.
3. The queue is loaded automatically — adjust if needed and execute.

## Available Functions

| Function | Description |
|---|---|
| `open_url` | Opens a URL in the browser |
| `get_current_url` | Returns the current page URL |
| `get_title` | Returns the current page title |
| `back` | Navigates back in browser history |
| `forward` | Navigates forward in browser history |
| `refresh` | Reloads the current page |
| `maximize_window` | Maximizes the browser window |
| `minimize_window` | Minimizes the browser window |
| `implicit_wait` | Sets implicit wait (seconds) |
| `explicit_wait` | Waits for a CSS selector to be present |
| `wait_seconds` | Pauses for a set number of seconds |
| `click_by_id` | Clicks an element by ID |
| `click_by_name` | Clicks an element by name attribute |
| `click_by_xpath` | Clicks an element by XPath |
| `click_by_css` | Clicks an element by CSS selector |
| `click_by_link_text` | Clicks a link by its visible text |
| `fill_by_id` | Types into an input field by ID |
| `fill_by_name` | Types into an input field by name |
| `fill_by_xpath` | Types into an input field by XPath |
| `fill_by_css` | Types into an input field by CSS selector |
| `submit_by_id` | Submits a form by element ID |
| `submit_by_xpath` | Submits a form by XPath |
| `select_by_name` | Selects a dropdown option by name |
| `send_keys_action` | Sends keyboard input to the focused element |
| `switch_to_frame_by_name` | Switches to an iframe by name or ID |
| `switch_to_default_content` | Returns context to the main page |
| `switch_to_parent_frame` | Switches to the parent frame |
| `switch_to_window` | Switches to another browser window |
| `accept_alert` | Accepts a browser alert |
| `dismiss_alert` | Dismisses a browser alert |
| `get_alert_text` | Returns the text of a browser alert |
| `close_browser` | Closes the browser and ends the session |

## Project Structure

```
SeleniumApp/
├── main.py          # GUI application and queue execution logic
├── functions.py     # Selenium helper functions used as queue steps
└── custom/          # Saved queue scripts (JSON)
    └── *.json
```

## Custom Script Format

Saved scripts in `custom/` follow this JSON structure:

```json
[
  {
    "func": "click_by_id",
    "enabled": true,
    "delay": "1",
    "inputs": {
      "element_id": "submit-btn"
    }
  }
]
```
