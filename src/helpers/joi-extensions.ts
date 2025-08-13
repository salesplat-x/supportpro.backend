import OriginalJoi from 'joi';
import { PhoneNumberUtil } from 'google-libphonenumber';

const phoneUtil = PhoneNumberUtil.getInstance();
 
// This is our custom validator logic
const phoneNumberValidator = (value: string, helpers: OriginalJoi.
 CustomHelpers) => {
  try {
    const parsedNumber = phoneUtil.parseAndKeepRawInput(value);
        if (!phoneUtil.isValidNumber(parsedNumber)) {
          // Return a Joi error if the number is not valid
          return helpers.error('string.phoneNumber.invalid');
        }
        // Return the original value if it's valid
        return value;
      } catch (error) {
        // The parsing library throws an error for fundamentally invalid formats
        return helpers.error('string.phoneNumber.invalid');
      }
    };
    
    // Here we extend Joi with our new rule
    export const Joi = OriginalJoi.extend((joi) => ({
      type: 'string',
      base: joi.string(),
      messages: {
        // Custom error message for our rule
        'string.phoneNumber.invalid': '{{#label}} must be a valid international phone number e.g., +2348058272524',
      },
      rules: {
        phoneNumber: {
          validate(value, helpers) {
            return phoneNumberValidator(value, helpers);
          },
        },
      },
    }));