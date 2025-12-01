fix the webui after postgres migration:

- currently the webui api doesnt work, not sure if its the bot api or the middleware
  - need to debug and tracelogs for where we're sending empty responses

  example response from webui /api/users

  ```
  {"users":{},"total":{},"limit":50,"offset":0}
  ```

  this is replicated across most (if not all) api requests for the webui

  need to debug the postgres implementation and the workflow of the api to see where its failing, we still get responses just empty ones

  makes me think its the middleware not recieving info from the db and just failing open
  - should change the logic to fail closed (no reply to webui, send 408) if no info/entries from database being read
