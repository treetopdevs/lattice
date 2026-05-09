ExUnit.start()

ExUnit.configure(
  exclude: [
    browser_e2e: true,
    load: true
  ]
)
